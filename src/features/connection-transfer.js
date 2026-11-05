import { $ } from '../core/dom.js';
import { state, active } from '../core/state.js';
import { runtime } from '../core/runtime.js';
import { persist, storageGet } from '../core/storage.js';
import {
  normalizeConnection,
  parseConnectionFile,
  encodeConnectionFile,
  decodeConnectionFile,
  saveImportedConnection,
  MAX_CONNECTION_FILE_BYTES,
} from '../core/connection-file.js';
import { fetchGptModelCatalog, keyIndicator, parseBase } from '../services/connection.js';
import { resetQuotaCache, refreshSavedAccountBalance } from '../services/account.js';
import {
  applyGptProfile,
  rebuildModelControls,
  setGptModelInventory,
  isGptImageModel,
} from '../services/models.js';
import { parsePriceRules, formatPriceRules } from '../services/pricing.js';
import { applySettings, captureDraft, settingsSnapshot, updateSend } from './composer.js';
import { render } from './gallery.js';
import { saveBlob } from './transfers.js';
import { guard, notify, setStatus, showDialog } from '../ui/dialogs.js';

let pending = null,
  operation = 0,
  connectionSerial = 0,
  feedbackTimer;

function currentConnection() {
  const base = parseBase($('keyDlg').open ? $('baseInput').value : state.base);
  const apiKey = ($('keyDlg').open ? $('keyInput').value : state.key).trim();
  const origin = new URL(base).origin;
  let account;
  if (origin === new URL(state.base).origin) {
    account = { token: $('accountToken').value.trim(), userId: $('accountUserId').value.trim() };
  } else {
    try {
      account = JSON.parse(storageGet('openlux_quota_credentials_v1') || '{}')[origin];
    } catch {}
  }
  return normalizeConnection({
    base,
    preferences: {
      customModels: Array.from($('model').options, (option) => option.value).filter(
        isGptImageModel,
      ),
      currency: $('keyDlg').open ? $('priceCurrency').value : state.prefs.currency,
      prices: $('keyDlg').open ? parsePriceRules($('priceRules').value) : state.prefs.prices || {},
      generation: { ...settingsSnapshot(), n: Number($('n').value) },
    },
    ...(apiKey ? { apiKey } : {}),
    ...(account?.token ? { account: { token: account.token, userId: account.userId || '' } } : {}),
  });
}

function downloadConnection(file) {
  saveBlob(
    new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
    file.encrypted ? 'OpenLux-加密连接配置.json' : 'OpenLux-连接配置.json',
  );
}

function importFeedback(kind, message, detail = '') {
  clearTimeout(feedbackTimer);
  const zone = $('connectionDropZone');
  zone.dataset.state = kind;
  zone.setAttribute('aria-busy', String(kind === 'loading'));
  $('connectionDropLabel').textContent = message;
  zone.title =
    detail ||
    '拖入本工具导出的 JSON，自动保存密钥、模型和价格，并刷新模型与余额；也可点击选择文件。';
  if (kind !== 'loading')
    feedbackTimer = setTimeout(() => {
      zone.dataset.state = 'idle';
      $('connectionDropLabel').textContent = '导入配置';
    }, 4500);
}

async function refreshImportedConnection(serial, base, key, generation) {
  const current = () => serial === connectionSerial && state.base === base && state.key === key;
  const modelQuery = (async () => {
    if (!key) return null;
    if (current()) $('modelsStatus').textContent = '正在刷新…';
    const result = await fetchGptModelCatalog(base, key);
    if (!current()) return null;
    const models = setGptModelInventory(result.ids, base);
    if (generation?.model === $('model').value && generation.route && !$('route').value) {
      const route = Array.from($('route').options).find(
        (option) => option.value === generation.route,
      );
      if (route && !route.disabled) $('route').value = route.value;
    }
    updateSend();
    captureDraft();
    const saved = await persist();
    if (!saved) throw new Error('模型已刷新，但浏览器未能保存模型设置。');
    if (current()) {
      $('modelsStatus').textContent = `已刷新 ${models.length} 个 GPT 生图模型`;
      updateSend();
    }
    return models.length;
  })();
  const results = await Promise.allSettled([modelQuery, refreshSavedAccountBalance()]);
  if (!current()) return;
  const problems = [];
  if (results[0].status === 'rejected') {
    $('modelsStatus').textContent = '刷新失败，可稍后重新读取';
    problems.push('模型列表刷新失败');
  }
  if (results[1].status === 'rejected' || results[1].value === false)
    problems.push('账户余额刷新失败');
  if (problems.length) {
    const message = `配置已保存；${problems.join('，')}，可稍后重试。`;
    importFeedback('warning', '已保存', message);
    setStatus(message);
    notify(message);
  } else {
    importFeedback('success', '已保存');
    const refreshed = [];
    if (results[0].status === 'fulfilled' && results[0].value !== null) refreshed.push('模型列表');
    if (results[1].value === true) refreshed.push('账户余额');
    setStatus('配置已导入并保存。' + (refreshed.length ? refreshed.join('与') + '已刷新。' : ''));
  }
}

async function applyConnection(connection) {
  const saved = saveImportedConnection(connection),
    serial = ++connectionSerial;
  importFeedback('loading', '保存中…');
  state.base = saved.base;
  state.key = saved.apiKey;
  // Importing credentials must never start old paid jobs with a new connection.
  if (state.tasks.some(active)) state.queuePaused = true;
  // Available models must be rechecked for the imported key, even on the same host.
  state.prefs.gptCatalog = null;
  const preferences = saved.preferences || {};
  for (const key of ['customModels', 'prices', 'currency']) {
    if (Object.hasOwn(preferences, key)) state.prefs[key] = preferences[key];
  }
  if (
    preferences.generation?.model &&
    !state.prefs.customModels.includes(preferences.generation.model)
  ) {
    state.prefs.customModels.push(preferences.generation.model);
  }
  resetQuotaCache();
  keyIndicator();
  $('baseInput').value = saved.base;
  $('keyInput').value = saved.apiKey;
  $('keyInput').type = 'password';
  $('showKey').textContent = '显示';
  $('rememberKey').checked = !!saved.apiKey;
  $('priceCurrency').value = state.prefs.currency;
  $('priceRules').value = formatPriceRules(state.prefs.prices);
  rebuildModelControls();
  applySettings(preferences.generation);
  if (preferences.generation?.n) $('n').value = preferences.generation.n;
  applyGptProfile(true);
  captureDraft();
  updateSend();
  render();
  const persisted = await persist();
  if (!persisted) {
    importFeedback(
      'warning',
      '保存未完成',
      '密钥已保存，但模型、价格和参数未能保存；请检查浏览器存储空间。',
    );
    notify('密钥已保存，但模型和价格未能持久保存；请检查浏览器存储空间。');
    return;
  }
  setStatus(
    state.queuePaused
      ? '配置已保存，原有队列保持暂停；正在刷新模型与余额。'
      : '配置已保存，正在刷新模型与余额。',
  );
  notify('配置已导入并保存，下次打开无需重新填写。');
  importFeedback('loading', '刷新中…');
  void refreshImportedConnection(serial, saved.base, saved.apiKey, preferences.generation);
}

function openPassword(mode, value) {
  pending = { mode, value };
  $('connectionPassword').value = '';
  $('connectionFileError').textContent = '';
  $('connectionFileTitle').textContent = mode === 'export' ? '加密连接文件' : '解锁连接文件';
  $('connectionFileHelp').textContent =
    mode === 'export'
      ? '设置文件密码，换电脑导入时使用。密码不会保存在浏览器中。'
      : '输入导出时设置的文件密码，解锁后会自动保存连接。';
  $('connectionPassword').autocomplete = mode === 'export' ? 'new-password' : 'current-password';
  $('connectionPassword').minLength = mode === 'export' ? 8 : 1;
  $('connectionFileSubmit').textContent = mode === 'export' ? '加密导出' : '解锁并保存';
  $('connectionFileSubmit').disabled = false;
  showDialog('connectionFileDlg');
  $('connectionPassword').focus();
}

async function importFile(file) {
  if (!state.ready) throw new Error('工作室正在载入，请稍后重新导入。');
  if (!isConfiguration(file)) throw new Error('这里只接受 .json 连接配置文件。');
  if (pending?.mode === 'import' && $('connectionFileDlg').open)
    throw new Error('请先解锁或关闭当前连接文件，再导入另一个文件。');
  if (file.size > MAX_CONNECTION_FILE_BYTES)
    throw new Error('连接配置文件过大，请选择工具导出的连接文件。');
  const parsed = parseConnectionFile(await file.text());
  if (parsed.encrypted) {
    importFeedback('idle', '等待解锁');
    openPassword('import', parsed);
  } else await applyConnection(parsed.connection);
}

function isConfiguration(file) {
  return /\.json$/i.test(file.name);
}

function importError(error) {
  importFeedback('error', '导入失败', error.message);
  notify(error.message);
}

export function mountConnectionTransfer() {
  const zone = $('connectionDropZone');
  zone.onclick = () => $('connectionFileInput').click();
  const clearDrag = () => zone.classList.remove('is-dragover');
  for (const type of ['dragenter', 'dragover'])
    window.addEventListener(
      type,
      (event) => {
        const files = Array.from(event.dataTransfer?.files || []),
          items = Array.from(event.dataTransfer?.items || []);
        const overZone = zone.contains(event.target),
          json =
            files.some(isConfiguration) ||
            items.some((item) => item.kind === 'file' && item.type === 'application/json');
        if ((!overZone && !json) || !Array.from(event.dataTransfer?.types || []).includes('Files'))
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        runtime.dragDepth = 0;
        $('dropOverlay').hidden = true;
        const allowed = json || (!files.length && items.every((item) => !item.type));
        zone.classList.toggle('is-dragover', allowed);
        event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
      },
      true,
    );
  zone.addEventListener('dragleave', (event) => {
    if (!zone.contains(event.relatedTarget)) clearDrag();
  });
  window.addEventListener('dragend', clearDrag, true);
  window.addEventListener(
    'dragleave',
    (event) => {
      if (!event.relatedTarget) clearDrag();
    },
    true,
  );

  $('exportConnection').onclick = guard(async () => {
    downloadConnection(await encodeConnectionFile(currentConnection()));
    notify('连接文件已导出，可在另一台电脑直接拖入。');
  });
  $('exportEncryptedConnection').onclick = guard(() => openPassword('export', currentConnection()));
  $('importConnection').onclick = () => $('connectionFileInput').click();
  $('connectionFileInput').onchange = async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) {
      try {
        await importFile(file);
      } catch (error) {
        importError(error);
      }
    }
  };
  $('connectionFileForm').onsubmit = async (event) => {
    event.preventDefault();
    if (!pending || $('connectionFileSubmit').disabled) return;
    const serial = ++operation,
      work = pending,
      password = $('connectionPassword').value;
    $('connectionFileSubmit').disabled = true;
    $('connectionFileError').textContent = '';
    try {
      if (work.mode === 'export') {
        const file = await encodeConnectionFile(work.value, password);
        if (serial !== operation || !$('connectionFileDlg').open) return;
        downloadConnection(file);
      } else {
        const connection = await decodeConnectionFile(work.value, password);
        if (serial !== operation || !$('connectionFileDlg').open) return;
        await applyConnection(connection);
      }
      $('connectionPassword').value = '';
      pending = null;
      $('connectionFileDlg').close();
    } catch (error) {
      if (serial === operation) $('connectionFileError').textContent = error.message;
    } finally {
      if (serial === operation) $('connectionFileSubmit').disabled = false;
    }
  };
  $('connectionFileDlg').addEventListener('close', () => {
    operation++;
    pending = null;
    $('connectionPassword').value = '';
    $('connectionFileError').textContent = '';
    $('connectionFileSubmit').disabled = false;
  });
  // Capture JSON drops before the reference-image listener, including while settings are open.
  window.addEventListener(
    'drop',
    (event) => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (!zone.contains(event.target) && !files.some(isConfiguration)) return;
      clearDrag();
      event.preventDefault();
      event.stopImmediatePropagation();
      runtime.dragDepth = 0;
      $('dropOverlay').hidden = true;
      if (files.length !== 1) {
        importError(new Error('请一次拖入一个 JSON 连接配置文件。'));
        return;
      }
      importFile(files[0]).catch(importError);
    },
    true,
  );
}
