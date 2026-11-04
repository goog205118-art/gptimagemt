export const CONNECTION_FORMAT = 'openlux-connection';
export const MAX_CONNECTION_FILE_BYTES = 96 * 1024;
const ITERATIONS = 310000;
const encoder = new TextEncoder();
const aad = encoder.encode(CONNECTION_FORMAT + ':1');

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function secret(value, label) {
  if (typeof value !== 'string' || value.length > 16000 || /[\r\n]/.test(value)) {
    throw new Error(`${label}格式无效。`);
  }
  const normalized = value.trim().replace(/^Bearer\s+/i, '');
  if (/\s/.test(normalized)) throw new Error(`${label}不能包含空格或换行。`);
  return normalized;
}

export function normalizeConnection(value) {
  if (!record(value) || typeof value.base !== 'string' || value.base.length > 2048) {
    throw new Error('连接配置中缺少有效的 API 地址。');
  }
  let url;
  try {
    url = new URL(value.base);
  } catch {
    throw new Error('连接配置中的 API 地址无效。');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('连接配置中的 API 地址无效。');
  }
  const result = {
    base: url.href.replace(/\/+$/, '').replace(/\/images\/(generations|edits)$/, ''),
  };
  if (Object.hasOwn(value, 'apiKey')) result.apiKey = secret(value.apiKey, 'API Key');
  if (Object.hasOwn(value, 'account')) {
    if (!record(value.account)) throw new Error('账户查询配置无效。');
    const token = secret(value.account.token ?? '', '账户查询令牌');
    const userId = value.account.userId ?? '';
    if (typeof userId !== 'string' || (userId && !/^\d{1,20}$/.test(userId))) {
      throw new Error('用户 ID 必须是数字。');
    }
    result.account = { token, userId };
  }
  if (!result.apiKey && !result.account?.token) throw new Error('连接文件中至少需要一个密钥。');
  return result;
}

function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value, length) {
  if (
    typeof value !== 'string' ||
    value.length > MAX_CONNECTION_FILE_BYTES ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error('加密连接文件格式无效。');
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('加密连接文件格式无效。');
  }
  if (length && bytes.length !== length) throw new Error('加密连接文件格式无效。');
  return bytes;
}

function cryptography() {
  if (!globalThis.crypto?.subtle) throw new Error('加密功能需要 HTTPS 或本地开发环境。');
  return globalThis.crypto;
}

async function derive(password, salt) {
  const crypto = cryptography();
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function parseConnectionFile(text) {
  if (typeof text !== 'string' || encoder.encode(text).length > MAX_CONNECTION_FILE_BYTES) {
    throw new Error('连接配置文件过大。');
  }
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('无法读取连接配置文件。');
  }
  if (!record(file) || file.format !== CONNECTION_FORMAT || file.version !== 1) {
    throw new Error('这不是连接配置文件。作品备份请从「用量与备份」导入。');
  }
  if (file.encrypted === false)
    return { ...file, connection: normalizeConnection(file.connection) };
  if (
    file.encrypted !== true ||
    !record(file.crypto) ||
    file.crypto.cipher !== 'AES-GCM' ||
    file.crypto.kdf !== 'PBKDF2-SHA256' ||
    file.crypto.iterations !== ITERATIONS
  ) {
    throw new Error('不支持的连接文件版本或加密方式。');
  }
  fromBase64(file.crypto.salt, 16);
  fromBase64(file.crypto.iv, 12);
  const ciphertext = fromBase64(file.ciphertext);
  if (ciphertext.length < 17) throw new Error('加密连接文件不完整。');
  return file;
}

export async function encodeConnectionFile(connection, password = '') {
  if (typeof password !== 'string') throw new Error('文件密码格式无效。');
  const normalized = normalizeConnection(connection);
  const file = {
    format: CONNECTION_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    encrypted: !!password,
  };
  if (!password) return { ...file, connection: normalized };
  if (password.length < 8 || password.length > 1024)
    throw new Error('文件密码请使用 8–1024 个字符。');
  const crypto = cryptography(),
    salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    encoder.encode(JSON.stringify(normalized)),
  );
  return {
    ...file,
    crypto: {
      cipher: 'AES-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: ITERATIONS,
      salt: toBase64(salt),
      iv: toBase64(iv),
    },
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function decodeConnectionFile(input, password = '') {
  const file =
    typeof input === 'string'
      ? parseConnectionFile(input)
      : parseConnectionFile(JSON.stringify(input));
  if (!file.encrypted) return file.connection;
  if (typeof password !== 'string' || !password || password.length > 1024)
    throw new Error('请输入连接文件密码。');
  let clear;
  try {
    const key = await derive(password, fromBase64(file.crypto.salt, 16));
    clear = await cryptography().subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(file.crypto.iv, 12), additionalData: aad },
      key,
      fromBase64(file.ciphertext),
    );
  } catch {
    throw new Error('文件密码不正确，或连接文件已损坏。');
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(clear));
  } catch {
    throw new Error('连接文件内容无效。');
  }
  return normalizeConnection(value);
}

export function saveImportedConnection(input, storage = globalThis.localStorage) {
  const connection = normalizeConnection(input),
    origin = new URL(connection.base).origin;
  const keys = [
    'openlux_base',
    'openlux_key',
    'openlux_quota_credentials_v1',
    'openlux_account_balance_v1',
  ];
  const previous = new Map();
  try {
    for (const key of keys) previous.set(key, storage.getItem(key));
  } catch {
    throw new Error('当前浏览器无法保存连接，请检查本地存储设置。');
  }
  function map(key) {
    try {
      const value = JSON.parse(previous.get(key) || '{}');
      return record(value) ? value : {};
    } catch {
      return {};
    }
  }
  let sameOrigin = false;
  try {
    sameOrigin = new URL(previous.get('openlux_base')).origin === origin;
  } catch {}
  const apiKey = connection.apiKey ?? (sameOrigin ? previous.get('openlux_key') || '' : '');
  const writes = new Map([
    ['openlux_base', connection.base],
    ['openlux_key', apiKey || null],
  ]);
  if (connection.account) {
    const accounts = map('openlux_quota_credentials_v1'),
      balances = map('openlux_account_balance_v1');
    accounts[origin] = { ...connection.account, remember: true };
    delete balances[origin];
    writes.set('openlux_quota_credentials_v1', JSON.stringify(accounts));
    writes.set('openlux_account_balance_v1', JSON.stringify(balances));
  }
  try {
    for (const [key, value] of writes)
      value === null ? storage.removeItem(key) : storage.setItem(key, value);
  } catch {
    for (const [key, value] of previous) {
      try {
        value === null ? storage.removeItem(key) : storage.setItem(key, value);
      } catch {}
    }
    throw new Error('连接未能保存，原有连接已保留。请检查浏览器存储空间。');
  }
  return { ...connection, apiKey };
}
