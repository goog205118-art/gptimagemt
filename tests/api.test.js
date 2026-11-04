import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import quota from '../api/quota.js';
import models from '../api/models.js';

const nativeFetch = globalThis.fetch;
let server,
  base,
  upstreamCalls = [];
before(async () => {
  server = createServer((request, response) => {
    const handler = { '/api/quota': quota, '/api/models': models }[request.url];
    if (handler) handler(request, response);
    else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
  globalThis.fetch = nativeFetch;
  upstreamCalls = [];
});
after(() => new Promise((resolve) => server.close(resolve)));

function mockProvider(resolve) {
  globalThis.fetch = async (url, options) => {
    upstreamCalls.push({ url, options });
    return resolve(url, options);
  };
}
function post(path, body, headers = {}) {
  return nativeFetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer example-key',
      Origin: base,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('account query returns quota fields only and sends account authentication correctly', async () => {
  mockProvider((url, options) => {
    if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500000 } });
    assert.equal(url, 'https://api.openlux.ai/api/user/self');
    assert.equal(options.headers.Authorization, 'Bearer example-key');
    assert.equal(options.headers['New-Api-User'], '42');
    assert.equal(options.redirect, 'error');
    return Response.json({
      success: true,
      data: {
        quota: 1500000,
        used_quota: 500000,
        username: 'private-profile',
        access_token: 'never-return',
      },
    });
  });
  const response = await post('/api/quota', {
    origin: 'https://api.openlux.ai',
    mode: 'account',
    userId: '42',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    success: true,
    data: { quota: 1500000, used_quota: 500000 },
    quota_per_unit: 500000,
  });
});

test('unlimited Key is distinct from account balance and does not send a user header', async () => {
  mockProvider((url, options) => {
    if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500000 } });
    assert.ok(url.endsWith('/api/usage/token/'));
    assert.equal(options.headers['New-Api-User'], undefined);
    return Response.json({
      success: true,
      data: {
        total_available: -125,
        total_used: 125,
        total_granted: 0,
        unlimited_quota: true,
        expires_at: 0,
      },
    });
  });
  const response = await post('/api/quota', { origin: 'https://api.openlux.ai', mode: 'key' });
  const { data } = await response.json();
  assert.equal(data.unlimited_quota, true);
  assert.equal(data.total_available, -125);
  assert.equal(data.quota, undefined);
});

test('HTTP-200 authentication errors are classified without echoing submitted or upstream secrets', async () => {
  mockProvider((url) =>
    Response.json(
      url.endsWith('/api/status')
        ? { data: {} }
        : {
            success: false,
            message: '无权 access token invalid: example-key',
            debug: 'private-profile',
          },
    ),
  );
  const response = await post('/api/quota', {
    origin: 'https://api.openlux.ai',
    mode: 'account',
    userId: '42',
  });
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.ok(!text.includes('example-key') && !text.includes('private-profile'));
});

test('model endpoint filters other model families', async () => {
  mockProvider(() =>
    Response.json({
      data: [
        'gpt-image-2',
        'gemini-image',
        'gpt-4o',
        'gpt-image-2.5-sunburst',
        'gpt-image-2-c',
      ].map((id) => ({ id })),
    }),
  );
  const response = await post('/api/models', { origin: 'https://api.openlux.ai' });
  assert.deepEqual(await response.json(), {
    data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2.5-sunburst' }, { id: 'gpt-image-2-c' }],
    filtered_count: 2,
  });
});

test('no arbitrary host forwarding, cross-site access, invalid IDs or missing keys', async () => {
  mockProvider(() => {
    throw new Error('Invalid request reached provider');
  });
  assert.equal(
    (await post('/api/quota', { origin: 'https://example.com', mode: 'key' })).status,
    400,
  );
  assert.equal(
    (await post('/api/quota', { origin: 'https://api.openlux.ai.evil.example', mode: 'key' }))
      .status,
    400,
  );
  assert.equal(
    (await post('/api/quota', { origin: 'https://api.openlux.ai', mode: 'account', userId: 'abc' }))
      .status,
    400,
  );
  assert.equal(
    (
      await post(
        '/api/quota',
        { origin: 'https://api.openlux.ai', mode: 'key' },
        { Origin: 'https://other.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await post('/api/models', { origin: 'https://api.openlux.ai' }, { Authorization: '' })).status,
    401,
  );
  assert.equal(upstreamCalls.length, 0);
});

test('unsupported methods and oversized requests fail without a provider request', async () => {
  mockProvider(() => {
    throw new Error('Invalid request reached provider');
  });
  const response = await nativeFetch(base + '/api/quota');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal(
    (
      await post('/api/quota', {
        origin: 'https://api.openlux.ai',
        mode: 'key',
        padding: 'x'.repeat(20000),
      })
    ).status,
    413,
  );
  assert.equal((await nativeFetch(base + '/api/health')).status, 404);
  assert.equal((await nativeFetch(base + '/api/test')).status, 404);
  assert.equal(upstreamCalls.length, 0);
});

test('missing balance and malformed provider responses never fabricate a zero balance', async () => {
  mockProvider((url) =>
    Response.json(
      url.endsWith('/api/status')
        ? { data: {} }
        : { success: true, data: { username: 'profile-only' } },
    ),
  );
  const response = await post('/api/quota', {
    origin: 'https://api.openlux.ai',
    mode: 'account',
    userId: '42',
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).data, undefined);
});
