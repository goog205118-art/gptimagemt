import { $, numeric } from '../core/dom.js';
import { state, taskById, taskTitle } from '../core/state.js';
import { applyGptProfile, gptModelLabel, isGptImageModel } from '../services/models.js';
import { notify, setStatus } from '../ui/dialogs.js';
import {
  closeParameterPanel,
  floating,
  pickerRoot,
  positionFloatingPanels,
  syncPickers,
  toggleParameterPanel,
} from '../ui/pickers.js';
import { copyRefs, extension, imageURL, outputBlob, referenceURL } from '../core/assets.js';
import { persist, storageSet } from '../core/storage.js';
import { runtime } from '../core/runtime.js';
import { renderRefs } from './references.js';
import { money, priceFor } from '../services/pricing.js';
import { pump } from './jobs.js';
import { uid } from '../core/utils.js';
function settingsSnapshot() {
  return {
    model: $('model').value,
    route: $('route').value,
    size: $('size').value,
    quality: $('quality').value,
    timeout: numeric('timeout', 30, 1800, 300),
    format: $('format').value,
    background: $('background').value,
    compression: numeric('compression', 0, 100, 90),
    base: state.base,
  };
}
function setSelect(id, value) {
  if (value == null) return;
  if (id === 'model' && !isGptImageModel(value)) {
    value = 'gpt-image-2';
    notify('旧记录的模型不在当前 GPT Image 支持范围，输入框已选用 GPT Image 2；历史记录保留。');
  }
  const el = $(id);
  if (!Array.from(el.options).some((o) => o.value === String(value)))
    el.add(new Option(id === 'model' ? gptModelLabel(value) : String(value), String(value)));
  el.value = value;
  syncPickers();
}
function applySettings(settings) {
  if (settings?.model != null) setSelect('model', settings.model);
  applyGptProfile(false);
  for (const id of ['route', 'size', 'quality', 'format', 'background'])
    if (settings?.[id] != null) setSelect(id, settings[id]);
  for (const id of ['timeout', 'compression'])
    if (settings?.[id] != null) $(id).value = settings[id];
}
function readDraft() {
  return {
    prompt: $('prompt').value,
    refs: copyRefs(state.refs),
    settings: settingsSnapshot(),
    constraints: $('constraints').value,
    projectId: $('draftProject').value || 'default',
    n: numeric('n', 1, 4, 1),
    variantAxis: $('variantAxis').value,
    variants: $('variants').value,
    parentId: state.parentId,
    editQueuedId: state.editQueuedId,
    mask: state.mask,
    updatedAt: Date.now(),
  };
}
function captureDraft() {
  state.draft = readDraft();
  storageSet(
    'openlux_draft_text',
    JSON.stringify({
      prompt: state.draft.prompt,
      updatedAt: state.draft.updatedAt,
    }),
  );
}
function scheduleDraft() {
  if (!state.ready) return;
  captureDraft();
  $('draftSaved').textContent = '正在保存…';
  clearTimeout(runtime.draftTimer);
  runtime.draftTimer = setTimeout(async () => {
    const ok = await persist();
    $('draftSaved').textContent = ok ? '草稿已保存' : '草稿未持久保存';
  }, 300);
  updateSend();
}
async function flushDraft() {
  clearTimeout(runtime.draftTimer);
  captureDraft();
  return persist();
}
function restoreDraft(d) {
  state.refs = copyRefs(d.refs);
  state.parentId = d.parentId || null;
  state.editQueuedId = d.editQueuedId || null;
  state.mask = d.mask || null;
  $('prompt').value = d.prompt || '';
  $('constraints').value = d.constraints || '';
  $('draftProject').value = d.projectId || 'default';
  $('n').value = d.n || 1;
  $('variantAxis').value = d.variantAxis || '';
  $('variants').value = d.variants || '';
  applySettings(d.settings);
  renderRefs();
  renderEditContext();
  updateSend();
}
function variantsList() {
  if (!$('variantAxis').value) return [''];
  return $('variants')
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function updateSend() {
  updateComposerPeek();
  applyGptProfile(false);
  const n = numeric('n', 1, 4, 1),
    variants = variantsList(),
    total = state.editQueuedId ? 1 : n * variants.length;
  $('sendLabel').textContent = state.editQueuedId
    ? '更新排队任务'
    : state.parentId
      ? `生成修改${total > 1 ? ' · ' + total + ' 张' : ''}`
      : total > 1
        ? `生成 ${total} 张`
        : '生成图片';
  $('genBtn').setAttribute('aria-label', $('sendLabel').textContent);
  $('genBtn').disabled = !state.ready || state.adding > 0 || state.submitting;
  const price = priceFor(settingsSnapshot());
  $('estimate').textContent =
    `本次 ${total} 张${price !== null ? ' · 估算 ' + money(total * price) : ''} · 每张独立请求${state.mask ? ' · 已附局部编辑蒙版' : ''}`;
  $('compression').disabled = $('format').value === 'png';
  syncPickers();
}
function renderEditContext() {
  const parent = taskById(state.parentId),
    queued = taskById(state.editQueuedId);
  $('editContext').hidden = !parent && !queued;
  $('promptLabel').textContent = queued ? '编辑排队任务' : parent ? '本次想修改什么' : '画面描述';
  $('prompt').placeholder = parent
    ? '例如：把背景换成浅灰，产品外形与 Logo 保持不变…'
    : '描述你想看到的画面，也可以直接拖入或粘贴参考图…';
  if (parent || queued) {
    const source = parent || queued;
    $('editThumb').src = parent
      ? imageURL(parent)
      : source.refs[0]
        ? referenceURL(source.refs[0])
        : '';
    $('editThumb').hidden = !$('editThumb').getAttribute('src');
    $('editTitle').textContent = queued
      ? '正在修改排队任务'
      : `基于「${taskTitle(parent)}」继续修改`;
    $('editSubtitle').textContent = state.mask
      ? '已圈定修改区域'
      : queued
        ? '保存后更新原任务，不会额外新增'
        : '会保留原版本，并创建新的分支';
    $('editMaskBtn').hidden = !state.refs[0];
  }
  $('n').disabled = !!queued;
  $('variantAxis').disabled = !!queued;
  $('variants').disabled = !!queued;
}
function expandAdvanced() {
  toggleParameterPanel();
}
function collapseAdvanced() {
  closeParameterPanel(false);
  $('composer').scrollTop = 0;
}
async function newDraft() {
  state.parentId = null;
  state.editQueuedId = null;
  state.mask = null;
  state.refs = [];
  $('prompt').value = '';
  $('constraints').value = '';
  $('variantAxis').value = '';
  $('variants').value = '';
  $('n').value = 1;
  collapseAdvanced();
  renderRefs();
  renderEditContext();
  scheduleDraft();
  expandComposer();
  $('prompt').focus();
  setStatus('新的创作已准备好，进行中的任务会继续。');
}
const starters = {
  product:
    '一张极简产品摄影：一只白色陶瓷咖啡杯，浅灰背景，柔和的自然侧光，细腻的材质与真实阴影，留白充足。',
  poster:
    '设计一张电影海报：深夜的海边公路，一辆老式汽车驶向远处的灯塔，胶片质感，克制的色彩，画面上方为片名预留空间。',
};
function focusComposer() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  collapseAdvanced();
  expandComposer();
  $('prompt').focus({
    preventScroll: true,
  });
  $('composer').scrollTop = 0;
}
async function continueTask(t) {
  const blob = await outputBlob(t);
  state.parentId = t.id;
  state.editQueuedId = null;
  state.mask = null;
  state.refs = [
    {
      id: uid(),
      blob,
      name: `底图-${t.id}.${extension(blob)}`,
      role: 'base',
      note: '以此图为基础，保持未指定的部分不变',
    },
  ];
  applySettings(t.settings);
  $('prompt').value = '';
  $('constraints').value = '保持主体结构、材质和未指定的内容不变。';
  $('draftProject').value = t.projectId || 'default';
  $('n').value = 1;
  $('variantAxis').value = '';
  $('variants').value = '';
  renderRefs();
  renderEditContext();
  scheduleDraft();
  focusComposer();
  setStatus('已选中此版本，写下本次修改要求即可。');
}
function importTask(t, queueEdit = false) {
  state.parentId = t.parentId || null;
  state.editQueuedId = queueEdit ? t.id : null;
  state.mask = t.mask
    ? {
        ...t.mask,
      }
    : null;
  state.refs = copyRefs(t.refs);
  applySettings(t.settings);
  $('prompt').value = t.prompt;
  $('constraints').value = t.constraints || '';
  $('draftProject').value = t.projectId || 'default';
  $('n').value = 1;
  $('variantAxis').value = t.variant && t.variantAxis ? t.variantAxis : '';
  $('variants').value = t.variant || '';
  renderRefs();
  renderEditContext();
  scheduleDraft();
  focusComposer();
  setStatus(
    queueEdit ? '编辑后点击更新，替换原排队任务。' : '已恢复原始提示词、参考图、参数与蒙版。',
  );
}
let composerBlurTimer;
function updateComposerPeek() {
  if (!$('composerPeek')) return;
  const text = $('prompt').value.trim();
  $('collapsedPrompt').textContent = text || '写下想法，或拖入参考图…';
  $('collapsedRefs').textContent = state.refs.length
    ? `${state.refs.length} 张参考${state.mask ? ' · 已选区' : ''}`
    : '';
}
function expandComposer(focus = false) {
  clearTimeout(composerBlurTimer);
  const form = $('composer');
  form.classList.remove('is-collapsed');
  $('composerContent').inert = false;
  $('composerContent').setAttribute('aria-hidden', 'false');
  $('composerPeek').setAttribute('aria-expanded', 'true');
  $('composerPeek').tabIndex = -1;
  if (focus)
    $('prompt').focus({
      preventScroll: true,
    });
}
function collapseComposer() {
  clearTimeout(composerBlurTimer);
  updateComposerPeek();
  $('composer').classList.add('is-collapsed');
  $('composerContent').inert = true;
  $('composerContent').setAttribute('aria-hidden', 'true');
  $('composerPeek').setAttribute('aria-expanded', 'false');
  $('composerPeek').tabIndex = 0;
}
function composerOwns(target) {
  return (
    target instanceof Node &&
    ($('composer').contains(target) ||
      (pickerRoot.contains(target) && floating.trigger && $('composer').contains(floating.trigger)))
  );
}
function scheduleComposerCollapse() {
  clearTimeout(composerBlurTimer);
  composerBlurTimer = setTimeout(() => {
    if (
      !composerOwns(document.activeElement) &&
      !floating.parameterOpen &&
      !(floating.select && composerOwns(floating.trigger))
    )
      collapseComposer();
  }, 140);
}
function mountFeaturesComposer() {
  $('advancedToggle').onclick = expandAdvanced;
  new ResizeObserver((entries) =>
    document.documentElement.style.setProperty('--header-h', entries[0].target.offsetHeight + 'px'),
  ).observe(document.querySelector('.topbar'));
  $('composer').addEventListener('input', (e) => {
    if (!e.target.matches('[data-ref-note]')) scheduleDraft();
  });
  $('composer').addEventListener('change', (e) => {
    if (e.target.id === 'concurrency') pump();
    scheduleDraft();
  });
  $('newBtn').onclick = newDraft;
  $('exitEdit').onclick = () => {
    state.parentId = null;
    state.editQueuedId = null;
    state.mask = null;
    renderEditContext();
    scheduleDraft();
  };
  $('clearRefs').onclick = () => {
    state.refs = [];
    state.mask = null;
    renderRefs();
    renderEditContext();
    scheduleDraft();
  };
  document.querySelectorAll('[data-starter]').forEach(
    (b) =>
      (b.onclick = () => {
        $('prompt').value = starters[b.dataset.starter];
        expandComposer();
        $('prompt').focus();
        scheduleDraft();
      }),
  );
  $('addRef').onclick = $('starterReference').onclick = () => $('fileInput').click();
  $('composerPeek').onclick = () => expandComposer(true);
  $('composer').addEventListener('input', updateComposerPeek);
  document.addEventListener('focusin', (e) => {
    if (composerOwns(e.target)) {
      clearTimeout(composerBlurTimer);
      if ($('composerContent').contains(e.target)) expandComposer();
    } else scheduleComposerCollapse();
  });
  $('composer').addEventListener('focusout', scheduleComposerCollapse);
  document.addEventListener('pointerdown', (e) => {
    if (!composerOwns(e.target)) scheduleComposerCollapse();
  });
  new ResizeObserver(() => positionFloatingPanels()).observe($('composer'));
  collapseComposer();
}
export {
  captureDraft,
  collapseAdvanced,
  continueTask,
  expandComposer,
  flushDraft,
  focusComposer,
  importTask,
  mountFeaturesComposer,
  readDraft,
  renderEditContext,
  restoreDraft,
  scheduleDraft,
  setSelect,
  settingsSnapshot,
  updateSend,
  variantsList,
};
