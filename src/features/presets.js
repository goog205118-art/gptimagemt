import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { runtime } from '../core/runtime.js';
import { escapeHTML, uid } from '../core/utils.js';
import { copyRefs } from '../core/assets.js';
import { persist } from '../core/storage.js';
import { presetVariables, renderPresetPrompt } from '../core/preset-template.js';
import { PROMPT_PRESET_SEEDS, PROMPT_PRESET_SEED_VERSION } from '../data/prompt-presets.js';
import { guard, notify, setStatus, showDialog } from '../ui/dialogs.js';
import { focusComposer, readDraft, restoreDraft, scheduleDraft } from './composer.js';
import { gptProfile } from '../services/models.js';
import { libraryThumbs, openLibrary, renderLibrary } from './library.js';

let editingId = null,
  usingId = null;

export function seedPromptPresets() {
  if (state.prefs.promptPresetSeedVersion >= PROMPT_PRESET_SEED_VERSION) return;
  const ids = new Set(state.presets.map((preset) => preset.id));
  state.presets.push(
    ...PROMPT_PRESET_SEEDS.filter((preset) => !ids.has(preset.id)).map((preset) => ({
      ...preset,
      refs: [],
      createdAt: Date.now(),
    })),
  );
  state.prefs.promptPresetSeedVersion = PROMPT_PRESET_SEED_VERSION;
}

export function presetItemsHTML(query = '') {
  const search = query.trim().toLowerCase();
  const presets = state.presets.filter(
    (preset) =>
      !search ||
      [preset.name, preset.category, preset.prompt, preset.notes]
        .join(' ')
        .toLowerCase()
        .includes(search),
  );
  return (
    presets
      .map((preset) => {
        const count = presetVariables(preset.prompt || '', preset.negative || '').length;
        return `<article class="library-item preset-item" data-lib-id="${escapeHTML(preset.id)}"><div class="item-content"><h3>${escapeHTML(preset.name)}</h3><div class="preset-meta"><span>${escapeHTML(preset.category || '自定义')}</span>${count ? `<span>${count} 项可填写</span>` : ''}${preset.kind === 'snapshot' || preset.settings ? '<span>含参考图 / 参数</span>' : ''}</div><p>${escapeHTML(preset.notes || preset.prompt || '参考图与参数预设')}</p>${preset.refs?.length ? libraryThumbs(preset.refs) : ''}</div><div class="preset-item-actions"><button class="btn outlined" data-lib-action="applyPreset">使用</button><button class="btn" data-lib-action="editPreset">编辑</button><button class="btn" data-lib-action="duplicatePreset">复制</button><button class="btn" data-lib-action="deletePreset">删除</button></div></article>`;
      })
      .join('') || '<div class="empty-library">没有找到对应预设，可以换个关键词或新建一个。</div>'
  );
}

export function openPresetEditor(id = null) {
  const preset = state.presets.find((item) => item.id === id);
  editingId = preset?.id || null;
  $('presetEditorTitle').textContent = preset ? '编辑提示词预设' : '新建提示词预设';
  for (const [field, value] of [
    ['presetName', preset?.name],
    ['presetCategory', preset?.category || '自定义'],
    ['presetPrompt', preset?.prompt],
    ['presetNegative', preset?.negative],
    ['presetNotes', preset?.notes],
  ])
    $(field).value = value || '';
  $('presetSnapshot').checked = preset ? preset.kind === 'snapshot' || !!preset.settings : false;
  $('presetExtras').open = !!preset?.negative || !!preset?.notes;
  showDialog('presetEditorDlg');
  $('presetName').focus();
}

export async function duplicatePreset(id) {
  const original = state.presets.find((item) => item.id === id);
  if (!original) return;
  const copy = {
    ...original,
    id: uid(),
    name: original.name + ' · 副本',
    refs: copyRefs(original.refs || []),
    createdAt: Date.now(),
  };
  state.presets.unshift(copy);
  await persist();
  renderLibrary();
  openPresetEditor(copy.id);
}

function currentPreset() {
  return state.presets.find((preset) => preset.id === usingId);
}
function variableValues() {
  return Object.fromEntries(
    Array.from($('presetVariables').querySelectorAll('input'), (input) => [
      input.dataset.variable,
      input.value,
    ]),
  );
}
function refreshPresetPreview() {
  const preset = currentPreset();
  if (!preset) return;
  const prompt = renderPresetPrompt(preset, variableValues(), $('presetIncludeNegative').checked);
  $('presetPreview').value = prompt;
  const limit = gptProfile($('model').value).maxPrompt;
  $('presetLength').textContent =
    `${prompt.length} 字符 · 当前模型完整提示词上限 ${limit}${prompt.length > limit ? '，导入后请精简或切换模型' : ''}`;
  $('presetLength').classList.toggle('error', prompt.length > limit);
}
function renderVariableFields(values = {}) {
  const preset = currentPreset();
  if (!preset) return;
  const fields = presetVariables(
    preset.prompt || '',
    $('presetIncludeNegative').checked ? preset.negative || '' : '',
  );
  if (fields.length > 24) throw new Error('模板变量过多，请精简到 24 项以内。');
  $('presetVariables').innerHTML = fields
    .map(
      (name, i) =>
        `<div class="field"><label for="presetVariable${i}">${escapeHTML(name)}</label><input type="text" id="presetVariable${i}" data-variable="${escapeHTML(name)}" value="${escapeHTML(values[name] || '')}" placeholder="填写${escapeHTML(name)}" maxlength="2000" required /></div>`,
    )
    .join('');
  $('presetVariableHelp').hidden = !fields.length;
  refreshPresetPreview();
}
export function usePreset(id) {
  const preset = state.presets.find((item) => item.id === id);
  if (!preset) return;
  usingId = id;
  $('presetUseTitle').textContent = preset.name;
  $('presetUseNote').textContent = preset.notes || '填写模板内容后导入，可以继续编辑再生成。';
  $('presetIncludeNegative').checked = !!preset.negative;
  $('presetNegativeCheck').hidden = !preset.negative;
  renderVariableFields();
  showDialog('presetUseDlg');
  ($('presetVariables').querySelector('input') || $('presetApply')).focus();
}

export function mountPresets() {
  $('promptPresetsBtn').onclick = () => openLibrary('presets');
  $('presetEditorForm').onsubmit = guard(async (event) => {
    event.preventDefault();
    const old = state.presets.find((preset) => preset.id === editingId),
      name = $('presetName').value.trim(),
      prompt = $('presetPrompt').value.trim();
    if (!name) throw new Error('请给预设填写名称。');
    const snapshot = $('presetSnapshot').checked;
    if (!prompt && !(snapshot && (old?.refs?.length || state.refs.length)))
      throw new Error('请填写提示词，或选择包含参考图的完整预设。');
    if (presetVariables(prompt, $('presetNegative').value).length > 24)
      throw new Error('模板变量过多，请精简到 24 项以内。');
    const draft = snapshot ? (old?.settings ? old : readDraft()) : null;
    const preset = {
      id: old?.id || uid(),
      name,
      category: $('presetCategory').value.trim() || '自定义',
      prompt,
      negative: $('presetNegative').value.trim(),
      notes: $('presetNotes').value.trim(),
      kind: snapshot ? 'snapshot' : 'prompt',
      refs: [],
      createdAt: old?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    if (draft)
      Object.assign(preset, {
        refs: copyRefs(draft.refs || []),
        settings: { ...draft.settings },
        constraints: draft.constraints || '',
        variantAxis: draft.variantAxis || '',
        variants: draft.variants || '',
        n: draft.n || 1,
        mask: draft.mask || null,
      });
    const index = state.presets.findIndex((item) => item.id === preset.id);
    if (index < 0) state.presets.unshift(preset);
    else state.presets[index] = preset;
    const saved = await persist();
    $('presetEditorDlg').close();
    if ($('libraryDlg').open) renderLibrary();
    notify(saved ? '提示词预设已保存。' : '当前预设已更新，但浏览器未能持久保存，请导出备份。');
  });
  $('presetVariables').addEventListener('input', refreshPresetPreview);
  $('presetIncludeNegative').onchange = guard(() => renderVariableFields(variableValues()));
  $('presetUseForm').onsubmit = guard((event) => {
    event.preventDefault();
    const preset = currentPreset();
    if (!preset) return;
    const prompt = renderPresetPrompt(preset, variableValues(), $('presetIncludeNegative').checked);
    if (preset.kind === 'snapshot' || preset.settings)
      restoreDraft({
        ...preset,
        prompt,
        projectId: $('draftProject').value,
        parentId: null,
        editQueuedId: null,
      });
    else $('prompt').value = prompt;
    scheduleDraft();
    focusComposer();
    setStatus('预设已导入，可以继续编辑后生成。');
  });
  $('libraryContent').addEventListener('input', (event) => {
    if (event.target.id !== 'presetSearch') return;
    runtime.presetSearch = event.target.value;
    $('presetItems').innerHTML = presetItemsHTML(event.target.value);
  });
}
