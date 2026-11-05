import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import agent from '../api/agent.js';
import {
  buildPlannerBody,
  extractPlanOutput,
  normalizePlan,
  recoverableRejection,
} from '../shared/agent-protocol.js';
import { state } from '../src/core/state.js';
import {
  authorizeAgentRun,
  reserveAgentRequest,
  nextAgentCandidate,
  syncAgentRuns,
} from '../src/core/agent-budget.js';
import {
  normalizeConnection,
  encodeConnectionFile,
  decodeConnectionFile,
  saveImportedConnection,
} from '../src/core/connection-file.js';

const context = {
  request: '产品摄影',
  references: [{ id: 'ref1', role: 'subject', note: '保持产品' }],
  currentSettings: { size: '1024x1024', format: 'png', background: 'auto' },
  availableModels: [
    { id: 'gpt-image-2', sizes: ['1024x1024'], qualities: ['medium'], maxPrompt: 32000 },
  ],
  maxRequests: 3,
  questionsRemaining: 2,
};
const plan = {
  decision: 'ready',
  summary: '保留产品，拍摄棚拍图',
  prompt: '产品摄影',
  constraints: '',
  model: 'gpt-image-2',
  size: '1024x1024',
  quality: 'medium',
  format: 'png',
  background: 'auto',
  count: 1,
  referenceRoles: [{ id: 'ref1', role: 'subject', note: '保持产品' }],
  questions: [],
};
const nativeFetch = globalThis.fetch;
let server, base;
before(async () => {
  server = createServer(agent);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
  globalThis.fetch = nativeFetch;
  state.agentRuns = [];
  state.tasks = [];
});
after(() => new Promise((resolve) => server.close(resolve)));
const post = (body, headers = {}) =>
  nativeFetch(base, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      Authorization: 'Bearer example-agent-key',
      ...headers,
    },
    body: JSON.stringify(body),
  });

test('planner request is bounded, contains low-detail image inputs, strict JSON and no tool permissions', () => {
  const body = buildPlannerBody({ context, previews: ['data:image/jpeg;base64,YQ=='] });
  assert.equal(body.model, 'gpt-6.1-sol');
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.input[0].content[1].detail, 'low');
  assert.equal(body.tools, undefined);
  assert.equal(buildPlannerBody({ context, strict: false }).text.format.type, 'json_object');
  assert.equal(body.max_output_tokens, 6000);
  assert.throws(() => buildPlannerBody({ context, previews: ['https://untrusted.example/a.png'] }));
});
test('structured plan preserves every reference and rejects invented models, excessive counts and incompatible outputs', () => {
  assert.equal(normalizePlan(plan, context).referenceRoles[0].id, 'ref1');
  for (const patch of [
    { model: 'invented' },
    { referenceRoles: [] },
    { count: 4 },
    { size: '3840x2160' },
    { quality: 'max' },
    { background: 'transparent', format: 'jpeg' },
  ])
    assert.throws(() => normalizePlan({ ...plan, ...patch }, context));
  assert.throws(() =>
    normalizePlan(plan, {
      ...context,
      currentSettings: { ...context.currentSettings, background: 'transparent' },
    }),
  );
  assert.throws(() => normalizePlan({ ...plan, size: 'auto' }, { ...context, hasMask: true }));
});
test('questions are bounded and incomplete or refused Responses never become a ready plan', () => {
  const question = {
    decision: 'clarify',
    summary: '需要用途',
    questions: [{ title: '用于哪里？', options: ['封面', '详情页'] }],
  };
  assert.equal(normalizePlan(question, context).questions[0].id, 'q1');
  assert.throws(() => normalizePlan(question, { ...context, questionsRemaining: 0 }));
  assert.deepEqual(
    extractPlanOutput({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }],
    }),
    plan,
  );
  assert.throws(() => extractPlanOutput({ status: 'incomplete' }));
  assert.throws(() => extractPlanOutput({ output: [{ content: [{ type: 'refusal' }] }] }));
});
test('fallback requires an explicit model/channel rejection; ambiguous, billing and refusal errors stop', () => {
  assert.equal(recoverableRejection(404, { error: { code: 'model_not_found' } }), true);
  assert.equal(recoverableRejection(400, { error: { message: '无可用渠道' } }), true);
  for (const status of [200, 401, 403, 429, 500, 502, 503, 504])
    assert.equal(recoverableRejection(status, { error: { code: 'model_not_found' } }), false);
  assert.equal(
    recoverableRejection(400, { error: { code: 'model_not_found', message: '余额不足' } }),
    false,
  );
});
function fixture() {
  state.key = 'example-image-key';
  state.base = 'https://api.openlux.ai/v1';
  const run = {
    id: 'run1',
    status: 'running',
    maxRequests: 3,
    requests: 0,
    costLimit: 0.6,
    usedEstimate: 0,
    prices: { 'gpt-image-2': 0.2, 'gpt-image-2-fast': 0.15, 'gpt-image-1': 0.1 },
    candidates: ['gpt-image-2-fast', 'gpt-image-1'],
    requestLog: [],
  };
  const task = {
    id: 'task1',
    status: 'running',
    agentRunId: run.id,
    refs: [],
    settings: { base: state.base, model: 'gpt-image-2', route: '' },
  };
  state.agentRuns = [run];
  state.tasks = [task];
  authorizeAgentRun(run);
  return { run, task };
}
test('parallel initial attempts, corrections, backoff and failovers share a single request and cost reservation', () => {
  const { run, task } = fixture();
  reserveAgentRequest(task);
  reserveAgentRequest({ ...task, id: 'task2', agentRequests: 0 });
  reserveAgentRequest(task);
  assert.equal(run.requests, 3);
  assert.equal(run.requestLog.length, 3);
  assert.ok(Math.abs(run.usedEstimate - 0.6) < 1e-8);
  assert.throws(() => reserveAgentRequest(task));
  run.requests = 0;
  run.usedEstimate = 0.5;
  assert.throws(() => reserveAgentRequest(task));
});
test('candidate validation preserves compatibility, skips incompatible models and stops on connection change', () => {
  const { task, run } = fixture();
  reserveAgentRequest(task);
  const next = nextAgentCandidate(
    task,
    404,
    { error: { code: 'model_not_found' } },
    (candidate) => {
      if (candidate.settings.model === 'gpt-image-2-fast') throw new Error('unsupported mask');
    },
  );
  assert.equal(next.model, 'gpt-image-1');
  run.stopped = true;
  assert.throws(() => reserveAgentRequest(task));
  run.stopped = false;
  state.key = 'changed-key';
  assert.throws(() => reserveAgentRequest(task));
  task.status = 'unknown';
  syncAgentRuns();
  assert.equal(run.status, 'unknown');
});
test('unknown price allows explicitly confirmed initial request only, never unpriced automatic retry', () => {
  const { task, run } = fixture();
  run.costLimit = null;
  run.prices = {};
  reserveAgentRequest(task);
  assert.equal(run.requests, 1);
  assert.throws(() => reserveAgentRequest(task));
});
test('fallback cannot consume requests or estimated funds reserved for other planned images', () => {
  const { task, run } = fixture();
  state.tasks.push(
    { ...task, id: 'task2', status: 'queued' },
    { ...task, id: 'task3', status: 'queued' },
  );
  reserveAgentRequest(task);
  assert.equal(
    nextAgentCandidate(task, 404, { error: { code: 'model_not_found' } }, () => {}),
    null,
  );
  assert.equal(run.requests, 1);
  reserveAgentRequest(state.tasks[1]);
  reserveAgentRequest(state.tasks[2]);
  assert.equal(run.requests, 3);
});
test('Agent proxy forwards only to fixed OpenLux Responses and does not expose credentials', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openlux.ai/v1/responses');
    assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body).model, 'gpt-6.1-sol');
    return Response.json({
      status: 'completed',
      output_text: JSON.stringify(plan),
      usage: { input_tokens: 20 },
    });
  };
  const response = await post({ action: 'plan', origin: 'https://api.openlux.ai', context });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(data.plan, plan);
  assert.ok(!JSON.stringify(data).includes('example-agent-key'));
});
test('model visibility is read-only; proxy rejects arbitrary hosts, cross-site calls and invalid images before fetch', async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.ok(url.endsWith('/v1/models'));
    return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
  };
  const response = await post({
    action: 'models',
    origin: 'https://api.openlux.ai',
    model: 'gpt-6.1-sol',
  });
  assert.deepEqual(await response.json(), { visible: true });
  for (const [body, headers] of [
    [{ action: 'plan', origin: 'https://arbitrary.example', context }, {}],
    [
      { action: 'plan', origin: 'https://api.openlux.ai', context },
      { 'Sec-Fetch-Site': 'cross-site' },
    ],
    [
      { action: 'plan', origin: 'https://api.openlux.ai', context, previews: ['file:///private'] },
      {},
    ],
  ])
    assert.ok((await post(body, headers)).status >= 400);
  assert.equal(calls, 1);
});
test('upstream errors cannot echo authentication secrets and do not retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      { error: { message: 'example-agent-key provider-secret' } },
      { status: 400 },
    );
  };
  const response = await post({ action: 'plan', origin: 'https://api.openlux.ai', context });
  assert.equal(response.status, 400);
  const raw = await response.text();
  assert.ok(!raw.includes('example-agent-key') && !raw.includes('provider-secret'));
  assert.equal(calls, 1);
});
test('portable encrypted connection carries independent Agent key and rolls back failed credential writes', async () => {
  const connection = normalizeConnection({
    base: 'https://api.openlux.ai/v1',
    apiKey: 'example-key',
    agent: {
      base: 'https://api.openlux.ai/v1',
      model: 'gpt-6.1-sol',
      useImageKey: false,
      apiKey: 'example-agent-secret',
      strict: true,
    },
  });
  const encoded = await encodeConnectionFile(connection, 'example-password');
  assert.ok(!JSON.stringify(encoded).includes('example-agent-secret'));
  const decoded = await decodeConnectionFile(encoded, 'example-password');
  assert.equal(decoded.agent.apiKey, 'example-agent-secret');
  const map = new Map();
  const storage = {
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => map.delete(k),
    setItem: (k, v) => map.set(k, v),
  };
  saveImportedConnection(decoded, storage);
  assert.equal(JSON.parse(map.get('openlux_agent_connection_v1')).apiKey, 'example-agent-secret');
  const previous = new Map(map);
  const failingStorage = {
    ...storage,
    setItem: (key, value) => {
      if (key === 'openlux_agent_connection_v1' && value.includes('replacement-secret'))
        throw new Error('full');
      map.set(key, value);
    },
  };
  assert.throws(() =>
    saveImportedConnection(
      {
        ...connection,
        apiKey: 'replacement-image',
        agent: { ...connection.agent, apiKey: 'replacement-secret' },
      },
      failingStorage,
    ),
  );
  assert.deepEqual(map, previous);
  assert.throws(() =>
    normalizeConnection({
      ...connection,
      agent: { ...connection.agent, base: 'https://not-openlux.example/v1' },
    }),
  );
});
