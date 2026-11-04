import { postQuery } from './http.js';
import { storageGet, storageSet } from '../core/storage.js';
import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { isOpenLuxBase } from './models.js';
import { notify, showDialog } from '../ui/dialogs.js';
const QUOTA_CREDENTIALS_KEY = 'openlux_quota_credentials_v1';
const ACCOUNT_BALANCE_KEY = 'openlux_account_balance_v1';
const quotaState = {
  keyData: null,
  accountData: null,
  unit: null,
  updatedAt: null,
  accountUpdatedAt: null,
  accountStatus: 'empty',
  busy: false,
  mode: 'account',
  accountToken: '',
  userId: '',
  serial: 0,
  error: '',
};
function accountBalanceMap() {
  try {
    const value = JSON.parse(storageGet(ACCOUNT_BALANCE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function loadAccountBalance() {
  const value = accountBalanceMap()[new URL(state.base).origin];
  if (value && typeof value.quota === 'number' && Number.isFinite(value.quota)) {
    quotaState.accountData = {
      quota: value.quota,
      used_quota: value.used_quota,
    };
    quotaState.unit = typeof value.unit === 'number' && value.unit > 0 ? value.unit : null;
    quotaState.accountUpdatedAt = value.updatedAt || null;
    quotaState.accountStatus = 'cached';
  } else {
    quotaState.accountData = null;
    quotaState.accountUpdatedAt = null;
    quotaState.accountStatus = 'empty';
  }
}
function cacheAccountBalance() {
  const map = accountBalanceMap();
  map[new URL(state.base).origin] = {
    ...quotaState.accountData,
    unit: quotaState.unit,
    updatedAt: quotaState.accountUpdatedAt,
  };
  storageSet(ACCOUNT_BALANCE_KEY, JSON.stringify(map));
}
function updateQuotaTrigger() {
  const data = quotaState.accountData,
    has = data?.quota != null && Number.isFinite(Number(data.quota)),
    label = has
      ? '余额 ' + quotaAmount(data.quota)
      : quotaState.busy && quotaState.mode === 'account'
        ? '余额查询中…'
        : quotaState.accountStatus === 'error'
          ? '余额待刷新'
          : '账户余额';
  $('quotaButtonLabel').textContent = label;
  $('quotaBtn').setAttribute(
    'aria-label',
    has ? '账户剩余' + quotaAmount(data.quota) : '查看账户余额',
  );
  $('quotaBtn').dataset.balanceState = quotaState.accountStatus;
  $('quotaBtn').title =
    (quotaState.accountStatus === 'cached'
      ? '上次查询的余额；'
      : quotaState.accountStatus === 'error'
        ? '刷新失败，显示上次余额；'
        : '') +
    (quotaState.accountUpdatedAt
      ? '账户余额更新于 ' + new Date(quotaState.accountUpdatedAt).toLocaleString('zh-CN')
      : '点击查询账户余额');
}
function refreshSavedAccountBalance() {
  if (
    isOpenLuxBase(state.base) &&
    $('accountToken').value.trim() &&
    /^\d+$/.test($('accountUserId').value.trim())
  ) {
    quotaState.mode = 'account';
    refreshQuota();
  }
}
function quotaCredentialMap() {
  try {
    const parsed = JSON.parse(storageGet(QUOTA_CREDENTIALS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function loadQuotaCredentials() {
  const saved = quotaCredentialMap()[new URL(state.base).origin] || {};
  quotaState.accountToken = typeof saved.token === 'string' ? saved.token : '';
  quotaState.userId = typeof saved.userId === 'string' ? saved.userId : '';
  $('accountToken').value = quotaState.accountToken;
  $('accountUserId').value = quotaState.userId;
  $('rememberQuota').checked = saved.remember !== false;
}
function saveQuotaCredentials() {
  const map = quotaCredentialMap(),
    origin = new URL(state.base).origin,
    remember = $('rememberQuota').checked,
    previousToken = quotaState.accountToken,
    previousUser = quotaState.userId;
  quotaState.accountToken = $('accountToken')
    .value.trim()
    .replace(/^Bearer\s+/i, '');
  quotaState.userId = $('accountUserId').value.trim();
  if (previousToken !== quotaState.accountToken || previousUser !== quotaState.userId) {
    quotaState.serial++;
    quotaState.busy = false;
    quotaState.error = '';
    quotaState.accountData = null;
    quotaState.accountUpdatedAt = null;
    quotaState.accountStatus = 'empty';
    const balances = accountBalanceMap();
    delete balances[origin];
    storageSet(ACCOUNT_BALANCE_KEY, JSON.stringify(balances));
    renderQuota();
  }
  map[origin] = remember
    ? {
        remember: true,
        token: quotaState.accountToken,
        userId: quotaState.userId,
      }
    : {
        remember: false,
      };
  if (!storageSet(QUOTA_CREDENTIALS_KEY, JSON.stringify(map)))
    notify('浏览器未能保存查询凭据，请检查存储设置。');
}
function quotaAmount(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return quotaState.unit
    ? `$${(n / quotaState.unit).toFixed(4)}`
    : `${n.toLocaleString('zh-CN')} 额度单位`;
}
function resetQuotaCache() {
  quotaState.serial++;
  quotaState.busy = false;
  quotaState.error = '';
  quotaState.keyData = null;
  quotaState.updatedAt = null;
  loadQuotaCredentials();
  loadAccountBalance();
  renderQuota();
}
function renderQuota() {
  updateQuotaTrigger();
  const data = quotaState.mode === 'account' ? quotaState.accountData : quotaState.keyData;
  $('quotaModeLabel').textContent =
    quotaState.mode === 'account' ? '账户剩余额度' : '当前 Key 剩余额度';
  $('quotaValue').textContent = data
    ? quotaState.mode === 'key' && data.unlimited_quota
      ? '未设限'
      : quotaAmount(quotaState.mode === 'account' ? data.quota : data.total_available)
    : '—';
  $('quotaUsed').textContent = data
    ? quotaAmount(quotaState.mode === 'account' ? data.used_quota : data.total_used)
    : '—';
  $('quotaExpiry').textContent =
    quotaState.mode === 'account'
      ? '账户余额'
      : !data
        ? '—'
        : data.expires_at > 0
          ? new Date(data.expires_at * 1000).toLocaleString('zh-CN')
          : '不过期';
  $('quotaTimestamp').textContent = quotaState.updatedAt
    ? '更新于 ' + new Date(quotaState.updatedAt).toLocaleTimeString('zh-CN')
    : '点击刷新获取最新额度';
  $('quotaStatus').textContent =
    quotaState.error ||
    (quotaState.busy
      ? '正在查询…'
      : data
        ? quotaState.mode === 'key' && data.unlimited_quota
          ? '当前 Key 没有限额，不代表账户余额无限。'
          : '额度由 OpenLux 接口实时返回。'
        : '尚未查询');
  $('quotaRefresh').disabled = quotaState.busy;
  $('accountQuotaFields').hidden = quotaState.mode !== 'account';
  document
    .querySelectorAll('[data-quota-mode]')
    .forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.quotaMode === quotaState.mode)),
    );
}
async function requestQuotaData(origin, account, token, user) {
  let json;
  try {
    json = await postQuery('/api/quota', origin, token, {
      mode: account ? 'account' : 'key',
      userId: user,
    });
  } catch (error) {
    if ([401, 403].includes(error.status))
      throw new Error(
        account
          ? '系统访问令牌或用户 ID 未通过验证。生图 Key 不能代替系统令牌。'
          : 'API Key 未通过验证，请更新连接中的 Key。',
      );
    throw error;
  }
  if (!json.data) throw new Error('查询未返回有效额度，请稍后刷新。');
  const unit = Number(json.quota_per_unit);
  return {
    data: json.data,
    unit: Number.isFinite(unit) && unit > 0 ? unit : null,
  };
}
async function refreshQuota() {
  if (quotaState.busy) return;
  if (!isOpenLuxBase(state.base)) {
    notify('额度接口仅适用于 OpenLux 官方连接。');
    return;
  }
  const account = quotaState.mode === 'account',
    token = account ? $('accountToken').value.trim() : state.key,
    user = account ? $('accountUserId').value.trim() : '';
  if (!token) {
    $('quotaStatus').textContent = account
      ? '请填写系统访问令牌和用户 ID；生图 Key 不能代替系统令牌。'
      : '请先保存 API Key。';
    return;
  }
  if (account && !/^\d+$/.test(user)) {
    $('quotaStatus').textContent = '请输入开发文档要求的数字用户 ID。';
    return;
  }
  if (account) saveQuotaCredentials();
  const serial = ++quotaState.serial,
    origin = new URL(state.base).origin;
  quotaState.busy = true;
  quotaState.error = '';
  renderQuota();
  try {
    const result = await requestQuotaData(origin, account, token.replace(/^Bearer\s+/i, ''), user);
    if (serial !== quotaState.serial) return;
    quotaState.unit = result.unit;
    if (account) {
      quotaState.accountData = {
        quota: result.data.quota,
        used_quota: result.data.used_quota,
      };
    } else {
      const d = result.data;
      quotaState.keyData = {
        total_available: d.total_available,
        total_used: d.total_used,
        total_granted: d.total_granted,
        unlimited_quota: !!d.unlimited_quota,
        expires_at: d.expires_at,
      };
    }
    quotaState.updatedAt = Date.now();
    if (account) {
      quotaState.accountUpdatedAt = quotaState.updatedAt;
      quotaState.accountStatus = 'fresh';
      cacheAccountBalance();
    }
    renderQuota();
  } catch (e) {
    if (serial === quotaState.serial) {
      if (account) quotaState.accountStatus = 'error';
      quotaState.error =
        e.name === 'TimeoutError'
          ? '额度查询超时，点击刷新可重试。'
          : e instanceof TypeError
            ? '额度接口暂时无法连接，请检查网络后刷新。'
            : e.message;
    }
  } finally {
    if (serial === quotaState.serial) {
      quotaState.busy = false;
      renderQuota();
    }
  }
}
function initializeAccountControls() {
  loadQuotaCredentials();
  loadAccountBalance();
  for (const id of ['accountToken', 'accountUserId'])
    $(id).addEventListener('input', saveQuotaCredentials);
  $('rememberQuota').onchange = saveQuotaCredentials;
  $('quotaBtn').onclick = () => {
    quotaState.serial++;
    quotaState.busy = false;
    quotaState.error = '';
    quotaState.mode = 'account';
    quotaState.updatedAt = quotaState.accountUpdatedAt;
    showDialog('quotaDlg');
    renderQuota();
    refreshQuota();
  };
  $('quotaRefresh').onclick = refreshQuota;
  document.querySelectorAll('[data-quota-mode]').forEach(
    (b) =>
      (b.onclick = () => {
        quotaState.serial++;
        quotaState.busy = false;
        quotaState.error = '';
        quotaState.updatedAt = null;
        quotaState.mode = b.dataset.quotaMode;
        renderQuota();
        if (quotaState.mode === 'key' || $('accountToken').value.trim()) refreshQuota();
      }),
  );
  $('accountClear').onclick = () => {
    quotaState.serial++;
    quotaState.busy = false;
    quotaState.error = '';
    quotaState.accountToken = '';
    quotaState.userId = '';
    quotaState.accountData = null;
    quotaState.accountUpdatedAt = null;
    quotaState.accountStatus = 'empty';
    const balances = accountBalanceMap();
    delete balances[new URL(state.base).origin];
    storageSet(ACCOUNT_BALANCE_KEY, JSON.stringify(balances));
    $('accountToken').value = '';
    $('accountUserId').value = '';
    const map = quotaCredentialMap();
    delete map[new URL(state.base).origin];
    storageSet(QUOTA_CREDENTIALS_KEY, JSON.stringify(map));
    renderQuota();
  };
  $('settingsForm').addEventListener('submit', () => queueMicrotask(resetQuotaCache));
  renderQuota();
}
export { initializeAccountControls, refreshSavedAccountBalance };
