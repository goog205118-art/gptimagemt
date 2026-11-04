import { GPT_SEED_MODELS, splitGptModel, isGptImageModel } from '../../shared/model-ids.js';
import { $ } from '../core/dom.js';
import { escapeHTML } from '../core/utils.js';
import { state } from '../core/state.js';
import { syncPickers } from '../ui/pickers.js';
import { effectivePrompt } from '../features/jobs.js';
import { scheduleDraft, updateSend } from '../features/composer.js';
function isOpenLuxBase(base) {
  try {
    return ['api.openlux.ai', 'api.openlux.uk'].includes(new URL(base).hostname);
  } catch {
    return false;
  }
}
function gptProfile(id) {
  const core = splitGptModel(id).core,
    v25 = core.startsWith('gpt-image-2.5-'),
    v2 = !v25 && /^gpt-image-2(?:-|$|\.0)/.test(core),
    mini = core.startsWith('gpt-image-1-mini'),
    v15 = core.startsWith('gpt-image-1.5'),
    compat = core.endsWith('-c');
  return {
    id,
    core,
    v25,
    v2,
    mini,
    v15,
    compat,
    legacy: core === 'gpt-image-1',
    label: gptModelLabel(id),
    qualities: v25
      ? ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
      : ['low', 'medium', 'high', 'auto'],
    maxRefs: core === 'gpt-image-2-c' ? 5 : 16,
    maxPrompt: v25 ? 1000 : 32000,
    flexible: v2 || v25 || core === 'chatgpt-image-latest',
    timeout: v25 ? (core.includes('sunburst') ? 900 : 600) : 300,
    fidelity: v15 ? 'high' : mini ? 'low' : core === 'gpt-image-1' ? 'high' : null,
  };
}
function gptModelLabel(id) {
  const { core, route } = splitGptModel(id);
  let label = core
    .replace(/^gpt-image-/, 'GPT Image ')
    .replace(/-c$/, ' · C')
    .replace(/-sunburst/, ' Sunburst')
    .replace(/-flare/, ' Flare')
    .replace(/-mini/, ' mini');
  if (core === 'chatgpt-image-latest') label = 'ChatGPT Image · latest';
  if (core === 'gpt-image-1') label += ' · 旧版兼容';
  return label + (route ? ' · ' + route.slice(1) : '');
}
function setGptModelInventory(ids, base, checkedAt = Date.now()) {
  const clean = Array.from(new Set(ids.filter(isGptImageModel))),
    select = $('model'),
    old = select.value;
  select.innerHTML = clean
    .map((id) => `<option value="${escapeHTML(id)}">${escapeHTML(gptModelLabel(id))}</option>`)
    .join('');
  if (!clean.length) {
    select.innerHTML = '<option value="" disabled>当前 Key 无可用 GPT 生图模型</option>';
    select.value = '';
  } else
    select.value = clean.includes(old)
      ? old
      : clean.includes('gpt-image-2')
        ? 'gpt-image-2'
        : clean[0];
  state.prefs.customModels = clean;
  state.prefs.gptCatalog = {
    ids: clean,
    base,
    checkedAt,
  };
  applyGptProfile(true);
  syncPickers();
  return clean;
}
let applyingGptProfile = false;
function applyGptProfile(normalize = false) {
  if (applyingGptProfile) return;
  applyingGptProfile = true;
  try {
    const id = $('model').value;
    if (!isGptImageModel(id)) return;
    const profile = gptProfile(id),
      quality = $('quality'),
      oldQuality = quality.value,
      labels = {
        low: '快速预览',
        medium: '标准质量',
        high: '高质量',
        xhigh: '超高清质量',
        max: '最高质量',
        auto: '自动质量',
      };
    const signature = profile.qualities.join(',');
    if (quality.dataset.gptSignature !== signature) {
      quality.dataset.gptSignature = signature;
      quality.innerHTML = profile.qualities
        .map((v) => `<option value="${v}">${labels[v]}</option>`)
        .join('');
      quality.value = profile.qualities.includes(oldQuality) ? oldQuality : 'high';
    }
    const catalog = state.prefs.gptCatalog,
      known = catalog?.base === state.base ? catalog.ids : null,
      modelHasRoute = !!splitGptModel(id).route;
    for (const option of $('route').options)
      if (option.value) {
        option.disabled = modelHasRoute || !known?.includes(id + option.value);
      }
    if (normalize && $('route').selectedOptions[0]?.disabled) $('route').value = '';
    for (const option of $('size').options) {
      if (option.value === 'auto') {
        option.disabled = false;
        continue;
      }
      option.disabled = !validGptSize(option.value, profile);
    }
    const protectedMask = state.mask && state.mask.keepOutside !== false;
    for (const option of $('format').options)
      option.disabled = !!protectedMask && option.value !== 'png';
    if (protectedMask) $('format').value = 'png';
    if (normalize && $('size').selectedOptions[0]?.disabled) $('size').value = 'auto';
    $('modelProfileHint').textContent = profile.v25
      ? `${profile.core.includes('sunburst') ? 'Sunburst · 精修优先' : 'Flare · 日常出图'} · 支持 2K / 4K、超高清与最高质量。${profile.compat ? 'C 路线以实际渠道能力为准。' : ''}`
      : profile.v2
        ? `GPT Image 2 · 高保真参考图，支持 2K / 4K 与多种画幅。${profile.compat ? 'C 路线最多 5 张参考图。' : ''}`
        : profile.v15
          ? 'GPT Image 1.5 · 编辑使用高输入保真，提供标准三种尺寸。'
          : profile.mini
            ? 'GPT Image 1 mini · 使用低输入保真，适合轻量草稿。'
            : '旧版兼容路线，是否可用以当前 Key 和服务商为准。';
    $('modelProfileHint').hidden = false;
    $('qualityNote').textContent = profile.v25
      ? '超高清 / 最高质量的耗时和费用更高。'
      : '按当前模型提供可用质量档。';
    $('modelTimeoutHint').textContent = `此模型建议超时 ${profile.timeout} 秒。`;
    $('promptBudget').textContent = profile.v25
      ? 'OpenLux 2.5：完整提示词上限 1000 字符（含参考说明）。'
      : '完整提示词上限 32000 字符。';
    $('gptMaskAdvice').textContent =
      isOpenLuxBase(state.base) && (profile.v25 || profile.v2)
        ? '智能兼容会使用选区位置引导，并保护未涂抹像素，避免当前渠道原生蒙版出现黑块或改错位置。原生模式可手动对照。'
        : '透明区域用于修改；选区外保护可保留其他原图像素。';
  } finally {
    applyingGptProfile = false;
  }
}
function validGptSize(size, profile) {
  if (size === 'auto') return true;
  const m = String(size).match(/^(\d+)x(\d+)$/);
  if (!m) return false;
  const w = Number(m[1]),
    h = Number(m[2]);
  if (!profile.flexible) return ['1024x1024', '1536x1024', '1024x1536'].includes(size);
  return (
    w % 16 === 0 &&
    h % 16 === 0 &&
    w > 0 &&
    h > 0 &&
    Math.max(w, h) <= 3840 &&
    Math.max(w, h) / Math.min(w, h) <= 3 &&
    w * h >= 655360 &&
    w * h <= 8294400
  );
}
function validateGptTask(t) {
  const s = t.settings,
    id = s.model + s.route;
  if (!isGptImageModel(id)) throw new Error('只支持 GPT Image 生图模型，请重新选择模型。');
  const p = gptProfile(id);
  if (splitGptModel(s.model).route && s.route)
    throw new Error('模型 ID 已包含路由后缀，请使用默认路由。');
  const catalog = state.prefs.gptCatalog;
  if (catalog?.base === s.base && !catalog.ids.includes(id))
    throw new Error(
      '当前模型或路由不在最近读取的可用 GPT 生图清单中，请重新读取模型或选择默认路由。',
    );
  if (!p.qualities.includes(s.quality))
    throw new Error(`${p.label} 不支持 ${s.quality} 质量，请重新选择。`);
  if (!validGptSize(s.size, p))
    throw new Error(
      `${p.label} 不支持当前尺寸。2.0 / 2.5 要求两边为 16 的倍数、像素 655360–8294400；旧版使用标准三种尺寸。`,
    );
  if (t.refs.length > p.maxRefs)
    throw new Error(`${p.label} 最多支持 ${p.maxRefs} 张参考图，请减少参考图。`);
  const prompt = t.effectivePrompt || effectivePrompt(t);
  if (prompt.length > p.maxPrompt)
    throw new Error(
      `此模型完整提示词限 ${p.maxPrompt} 字符，当前 ${prompt.length}（包含参考说明和保留要求）。请精简后提交。`,
    );
  if (s.background === 'transparent' && s.format === 'jpeg')
    throw new Error('透明背景请使用 PNG 或 WebP。');
  return p;
}
function initializeModelControls() {
  const saved = state.prefs.gptCatalog;
  if (saved?.ids?.length) setGptModelInventory(saved.ids, saved.base, saved.checkedAt);
  else {
    const ids = Array.from(
      new Set([...GPT_SEED_MODELS, ...state.prefs.customModels.filter(isGptImageModel)]),
    );
    const current = $('model').value;
    $('model').innerHTML = ids
      .map((id) => `<option value="${id}">${gptModelLabel(id)}</option>`)
      .join('');
    $('model').value = ids.includes(current) ? current : 'gpt-image-2';
    state.prefs.customModels = state.prefs.customModels.filter(isGptImageModel);
  }
  for (const size of ['2048x2048', '2048x1152', '3840x2160'])
    if (!Array.from($('size').options).some((o) => o.value === size))
      $('size').add(new Option(size, size));
  $('model').addEventListener('change', () => {
    applyGptProfile(true);
    const p = gptProfile($('model').value),
      timeout = $('timeout');
    if (Number(timeout.value) === Number(timeout.dataset.recommended || 300))
      timeout.value = p.timeout;
    timeout.dataset.recommended = p.timeout;
    updateSend();
    scheduleDraft();
  });
  applyGptProfile(true);
}
export {
  applyGptProfile,
  gptModelLabel,
  gptProfile,
  initializeModelControls,
  isGptImageModel,
  isOpenLuxBase,
  setGptModelInventory,
  validateGptTask,
};
