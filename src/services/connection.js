import { postQuery } from './http.js';
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
  $('keyLabel').textContent = state.key ? 'API 已连接' : '连接 API';
}
function showSettings() {
  $('baseInput').value = state.base;
  $('keyInput').value = state.key;
  $('rememberKey').checked = !!storageGet('openlux_key');
  $('keyInput').type = 'password';
  $('showKey').textContent = '显示';
  $('priceCurrency').value = state.prefs.currency;
  $('priceRules').value = Object.entries(state.prefs.prices || {})
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n');
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
      prices = {};
    for (const line of $('priceRules')
      .value.split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)) {
      const match = line.match(/^([^=]+)=\s*(\d+(?:\.\d+)?)$/);
      if (!match) throw new Error('价格格式应为：模型含路由 = 每张价格');
      prices[match[1].trim()] = Number(match[2]);
    }
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
      let data;
      if (isOpenLuxBase(base)) data = await postQuery('/api/models', new URL(base).origin, key);
      else {
        const response = await fetch(base + '/models', {
          headers: {
            Authorization: 'Bearer ' + key,
          },
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error('读取模型失败：HTTP ' + response.status);
        data = await response.json();
      }
      const ids = (data.data || []).map((item) => item.id).filter((id) => typeof id === 'string');
      const models = setGptModelInventory(ids, base);
      await persist();
      $('modelsStatus').textContent =
        `已读取 ${models.length} 个 GPT 生图模型，过滤 ${data.filtered_count ?? ids.length - models.length} 个其他模型`;
    } catch (e) {
      $('modelsStatus').textContent = '读取失败';
      throw e;
    } finally {
      $('fetchModels').disabled = false;
    }
  });
}
export { keyIndicator, mountServicesConnection, parseBase, showSettings };
