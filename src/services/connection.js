import { postQuery } from './http.js';
import { parsePriceRules, formatPriceRules } from './pricing.js';
import { isOpenLuxBase } from './models.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { persist, storageGet, storageSet } from '../core/storage.js';
import { guard, notify, setStatus, showDialog } from '../ui/dialogs.js';
import { scheduleDraft, setSelect } from '../features/composer.js';
import { pump } from '../features/jobs.js';
import { applyGptProfile, isGptImageModel, setGptModelInventory } from './models.js';
function keyIndicator() {
  $('keyDot').classList.toggle('ready', !!state.key);
  $('keyLabel').textContent = 'API';
  const label = (state.key ? 'API 已连接' : '尚未连接 API') + ' · 连接与偏好';
  $('keyBtn').setAttribute('aria-label', label);
  $('keyBtn').title = label;
}
function showSettings() {
  $('baseInput').value = state.base;
  $('keyInput').value = state.key;
  $('rememberKey').checked = !!storageGet('openlux_key');
  $('keyInput').type = 'password';
  $('showKey').textContent = '显示';
  $('priceCurrency').value = state.prefs.currency;
  $('priceRules').value = formatPriceRules(state.prefs.prices);
  $('autoRateRetry').checked = state.prefs.autoRateRetry;
  showDialog('keyDlg');
}
function parseBase(value) {
  const u = new URL(value.trim());
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error('请输入有效的 API 地址。');
  return u.href.replace(/\/+$/, '').replace(/\/images\/(generations|edits)$/, '');
}
function addModel(model) {
  if (!isGptImageModel(model) || model.length > 150)
    throw new Error(
      '仅允许 GPT Image 生图模型，例如 gpt-image-2、gpt-image-2.5-flare 或 gpt-image-2.5-sunburst。',
    );
  setSelect('model', model);
  if (!state.prefs.customModels.includes(model)) state.prefs.customModels.push(model);
  applyGptProfile(true);
}
async function fetchGptModelCatalog(base, key) {
  let data;
  if (isOpenLuxBase(base)) data = await postQuery('/api/models', new URL(base).origin, key);
  else {
    const response = await fetch(base + '/models', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('读取模型失败：HTTP ' + response.status);
    data = await response.json();
  }
  if (!Array.isArray(data.data)) throw new Error('模型接口没有返回有效的模型列表。');
  const ids = data.data.map((item) => item.id).filter((id) => typeof id === 'string');
  return {
    ids,
    filteredCount: data.filtered_count ?? ids.filter((id) => !isGptImageModel(id)).length,
  };
}
function mountServicesConnection() {
  $('keyBtn').onclick = showSettings;
  $('showKey').onclick = () => {
    const show = $('keyInput').type === 'password';
    $('keyInput').type = show ? 'text' : 'password';
    $('showKey').textContent = show ? '隐藏' : '显示';
  };
  $('settingsForm').onsubmit = guard(async (e) => {
    e.preventDefault();
    const base = parseBase($('baseInput').value),
      prices = parsePriceRules($('priceRules').value);
    state.base = base;
    state.key = $('keyInput').value.trim();
    if (!storageSet('openlux_key', $('rememberKey').checked && state.key ? state.key : null))
      notify('浏览器未能更新保存的 Key。');
    storageSet('openlux_base', base);
    state.prefs.prices = prices;
    state.prefs.currency = $('priceCurrency').value;
    state.prefs.autoRateRetry = $('autoRateRetry').checked;
    keyIndicator();
    $('keyDlg').close();
    scheduleDraft();
    await persist();
    pump();
    setStatus('连接与偏好已保存。');
  });
  $('addModelBtn').onclick = guard(() => {
    addModel($('customModel').value.trim());
    $('customModel').value = '';
    persist();
    notify('模型已加入选择列表。');
  });
  $('fetchModels').onclick = guard(async () => {
    const key = $('keyInput').value.trim(),
      base = parseBase($('baseInput').value);
    if (!key) throw new Error('先填写 API Key。');
    $('modelsStatus').textContent = '正在读取…';
    $('fetchModels').disabled = true;
    try {
      const { ids, filteredCount } = await fetchGptModelCatalog(base, key);
      if ($('keyInput').value.trim() !== key || parseBase($('baseInput').value) !== base) return;
      const models = setGptModelInventory(ids, base);
      await persist();
      $('modelsStatus').textContent =
        `已读取 ${models.length} 个 GPT 生图模型，过滤 ${filteredCount} 个其他模型`;
    } catch (e) {
      $('modelsStatus').textContent = '读取失败';
      throw e;
    } finally {
      $('fetchModels').disabled = false;
    }
  });
}
export { fetchGptModelCatalog, keyIndicator, mountServicesConnection, parseBase, showSettings };
