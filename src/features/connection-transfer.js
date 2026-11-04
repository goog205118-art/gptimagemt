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
import { keyIndicator, parseBase } from '../services/connection.js';
import { resetQuotaCache, refreshSavedAccountBalance } from '../services/account.js';
import { applyGptProfile } from '../services/models.js';
import { updateSend } from './composer.js';
import { render } from './gallery.js';
import { saveBlob } from './transfers.js';
import { guard, notify, setStatus, showDialog } from '../ui/dialogs.js';

let pending = null,
  operation = 0;

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

async function applyConnection(connection) {
  const saved = saveImportedConnection(connection);
  const previousBase = state.base;
  state.base = saved.base;
  state.key = saved.apiKey;
  // Importing credentials must never start old paid jobs with a new connection.
  if (state.tasks.some(active)) state.queuePaused = true;
  if (previousBase !== saved.base) state.prefs.gptCatalog = null;
  resetQuotaCache();
  keyIndicator();
  $('baseInput').value = saved.base;
  $('keyInput').value = saved.apiKey;
  $('keyInput').type = 'password';
  $('showKey').textContent = '显示';
  $('rememberKey').checked = !!saved.apiKey;
  applyGptProfile(true);
  updateSend();
  render();
  await persist();
  setStatus(
    state.queuePaused
      ? '连接已导入并保存；原有队列保持暂停。'
      : '连接配置已导入，并保存在当前浏览器。',
  );
  notify('连接已恢复，下次打开无需重新填写。');
  refreshSavedAccountBalance();
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
  if (file.size > MAX_CONNECTION_FILE_BYTES)
    throw new Error('连接配置文件过大，请选择工具导出的连接文件。');
  const parsed = parseConnectionFile(await file.text());
  if (parsed.encrypted) openPassword('import', parsed);
  else await applyConnection(parsed.connection);
}

function isConfiguration(file) {
  return /\.(json|openlux)$/i.test(file.name);
}

export function mountConnectionTransfer() {
  $('exportConnection').onclick = guard(async () => {
    downloadConnection(await encodeConnectionFile(currentConnection()));
    notify('连接文件已导出，可在另一台电脑直接拖入。');
  });
  $('exportEncryptedConnection').onclick = guard(() => openPassword('export', currentConnection()));
  $('importConnection').onclick = () => $('connectionFileInput').click();
  $('connectionFileInput').onchange = guard(async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) await importFile(file);
  });
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
      if (!files.some(isConfiguration)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runtime.dragDepth = 0;
      $('dropOverlay').hidden = true;
      if (files.length !== 1) {
        notify('请一次拖入一个连接配置文件。');
        return;
      }
      importFile(files[0]).catch((error) => notify(error.message));
    },
    true,
  );
}
