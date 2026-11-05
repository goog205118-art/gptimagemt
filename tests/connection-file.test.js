import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeConnectionFile,
  decodeConnectionFile,
  parseConnectionFile,
  saveImportedConnection,
  normalizeConnection,
  MAX_CONNECTION_FILE_BYTES,
} from '../src/core/connection-file.js';

const connection = {
  base: 'https://api.openlux.ai/v1',
  apiKey: 'example-image-key',
  account: { token: 'example-account-token', userId: '123' },
};
class MemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, value);
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

test('portable plain file includes only connection fields and normalizes the endpoint', async () => {
  const file = await encodeConnectionFile({
    ...connection,
    history: ['private'],
    password: 'ignored',
    prefs: { concurrency: 8 },
  });
  assert.deepEqual(await decodeConnectionFile(JSON.stringify(file)), connection);
  assert.equal(JSON.stringify(file).includes('private'), false);
  assert.deepEqual(
    normalizeConnection({
      base: connection.base + '/images/edits/',
      apiKey: ' Bearer example-key ',
    }),
    { base: connection.base, apiKey: 'example-key' },
  );
});

test('authenticated encrypted files round trip without plaintext credentials and use unique randomness', async () => {
  const file = await encodeConnectionFile(connection, 'a-test-password');
  const second = await encodeConnectionFile(connection, 'a-test-password');
  assert.equal(file.encrypted, true);
  assert.equal(JSON.stringify(file).includes(connection.apiKey), false);
  assert.equal(JSON.stringify(file).includes(connection.account.token), false);
  assert.notEqual(file.ciphertext, second.ciphertext);
  assert.deepEqual(await decodeConnectionFile(file, 'a-test-password'), connection);
  await assert.rejects(decodeConnectionFile(file, 'wrong-password'), /密码不正确/);
  file.ciphertext = (file.ciphertext[0] === 'A' ? 'B' : 'A') + file.ciphertext.slice(1);
  await assert.rejects(decodeConnectionFile(file, 'a-test-password'), /密码不正确/);
});

test('invalid, oversized and unrelated files fail before any configuration is applied', async () => {
  assert.throws(() => parseConnectionFile('x'.repeat(MAX_CONNECTION_FILE_BYTES + 1)), /过大/);
  assert.throws(() => parseConnectionFile('{"tasks":[]}'), /不是连接配置/);
  const file = await encodeConnectionFile(connection);
  assert.throws(() => parseConnectionFile(JSON.stringify({ ...file, version: 2 })), /不是连接配置/);
  assert.throws(
    () => normalizeConnection({ ...connection, base: 'https://user:pass@api.openlux.ai' }),
    /地址无效/,
  );
  assert.throws(
    () =>
      normalizeConnection({ ...connection, account: { token: 'token', userId: 'not-a-number' } }),
    /用户 ID/,
  );
  assert.throws(() => normalizeConnection({ ...connection, apiKey: 'a\nb' }), /格式无效/);
  await assert.rejects(encodeConnectionFile(connection, 'short'), /8–1024/);
});

test('import persists scoped credentials, clears stale balance and preserves unrelated browser data', () => {
  const storage = new MemoryStorage({
    unrelated: 'keep',
    openlux_quota_credentials_v1: JSON.stringify({ 'https://other.example': { token: 'other' } }),
    openlux_account_balance_v1: JSON.stringify({ 'https://api.openlux.ai': { quota: 100 } }),
  });
  saveImportedConnection(connection, storage);
  assert.equal(storage.getItem('openlux_key'), connection.apiKey);
  const accounts = JSON.parse(storage.getItem('openlux_quota_credentials_v1'));
  assert.deepEqual(accounts['https://api.openlux.ai'], { ...connection.account, remember: true });
  assert.equal(accounts['https://other.example'].token, 'other');
  assert.equal(storage.getItem('openlux_account_balance_v1'), '{}');
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('account-only import cannot send the previous provider key to a different provider', () => {
  const storage = new MemoryStorage({ openlux_base: connection.base, openlux_key: 'old-key' });
  assert.equal(
    saveImportedConnection({ base: connection.base, account: connection.account }, storage).apiKey,
    'old-key',
  );
  assert.equal(
    saveImportedConnection(
      { base: 'https://api.openlux.uk/v1', account: connection.account },
      storage,
    ).apiKey,
    '',
  );
  assert.equal(storage.getItem('openlux_key'), null);
});

test('failed browser storage writes roll back every connection field', () => {
  const storage = new MemoryStorage({
    openlux_base: 'https://old.example/v1',
    openlux_key: 'old-key',
    openlux_quota_credentials_v1: '{"old":{}}',
  });
  const before = new Map(storage.values);
  const setItem = storage.setItem.bind(storage);
  let writes = 0;
  storage.setItem = (key, value) => {
    if (++writes === 3) throw new Error('quota');
    setItem(key, value);
  };
  assert.throws(() => saveImportedConnection(connection, storage), /原有连接已保留/);
  assert.deepEqual(storage.values, before);
});

test('portable configuration carries validated model, prices and generation settings in plain and encrypted files', async () => {
  const preferences = {
    customModels: ['gpt-image-2', 'gpt-image-2.5-flare'],
    currency: 'USD',
    prices: { 'gpt-image-2': 0.2, 'gpt-image-2.5-flare': 0.35 },
    generation: {
      model: 'gpt-image-2.5-flare',
      size: '1536x1024',
      quality: 'xhigh',
      n: 2,
      format: 'webp',
      background: 'auto',
      timeout: 600,
      compression: 85,
      route: '',
    },
  };
  for (const password of ['', 'portable-test-password']) {
    const file = await encodeConnectionFile({ ...connection, preferences }, password);
    assert.deepEqual(await decodeConnectionFile(file, password), { ...connection, preferences });
  }
  const normalized = normalizeConnection({
    ...connection,
    preferences: {
      ...preferences,
      history: ['omit'],
      queuePaused: false,
      generation: { ...preferences.generation, base: 'https://untrusted.example' },
    },
  });
  assert.deepEqual(normalized.preferences, preferences);
});

test('invalid prices and model settings fail before any credential writes', () => {
  const invalid = [
    { customModels: ['unrelated-chat-model'] },
    { currency: 'OTHER' },
    { prices: { 'gpt-image-2': -0.1 } },
    { prices: { 'gpt-image-2': '0.2' } },
    { generation: { n: 100 } },
    { generation: { quality: 'unsupported' } },
  ];
  for (const preferences of invalid) {
    const storage = new MemoryStorage({ openlux_key: 'original-key' });
    assert.throws(() => saveImportedConnection({ ...connection, preferences }, storage));
    assert.equal(storage.getItem('openlux_key'), 'original-key');
    assert.equal(storage.getItem('openlux_base'), null);
  }
});
