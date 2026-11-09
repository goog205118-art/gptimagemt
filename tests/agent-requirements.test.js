import test from 'node:test';
import assert from 'node:assert/strict';
import { captureRequirements, requirementConflicts, executionIssues, planSignature, confirmedRequirements, automaticEligible, automationScope } from '../shared/agent-requirements.js';
import { compareOutput } from '../src/core/output-check.js';
import { recoverAgentSession } from '../src/core/agent-session.js';
import { state } from '../src/core/state.js';
import { syncAgentRuns } from '../src/core/agent-budget.js';

const ref = { id: 'base', role: 'subject', note: 'Logo 保持原样', blob: new Blob(['image']) };
const snapshot = { refs: [ref], settings: { size: '1024x1024', format: 'png', background: 'auto' }, constraints: 'Logo 保持原样', parentId: null };
const plan = { operation: 'create', baseId: '', count: 1, size: '1024x1024', model: 'gpt-image-2', format: 'png', background: 'auto', constraints: 'Logo 保持原样', exactText: '', referenceRoles: [{ id: 'base', role: 'subject', note: 'Logo 保持原样' }] };

test('A01 explicit count, square, reference roles and Logo constraints cannot drift unnoticed', () => {
  const locks = captureRequirements(snapshot, '1 张正方形主图，图一是主体，Logo 保持原样');
  const conflicts = requirementConflicts({ ...plan, count: 2, size: '1536x1024', referenceRoles: [{ id: 'base', role: 'style', note: '' }] }, locks);
  assert.deepEqual(conflicts.map((x) => x.field).sort(), ['count', 'ratio', 'reference:base']);
  assert.equal(locks.originalRequest, '1 张正方形主图，图一是主体，Logo 保持原样');
  assert.ok(locks.references[0].note.includes('Logo 保持原样'));
  const unlabelled = captureRequirements({ ...snapshot, refs: [{ ...ref, role: 'general', note: '' }] }, '图一是主体，11 张主图');
  assert.equal(unlabelled.references[0].role, 'subject');
  assert.equal(unlabelled.values.count, 11);
});
test('A02 selected branch inherits original confirmed wording and source without changing ancestor', () => {
  const inherited = { values: { constraints: '保留蓝色 Logo', exactText: 'Made in USA.' }, sources: { constraints: { kind: 'user', text: '保留蓝色 Logo' } } };
  const saved = structuredClone(inherited);
  const branch = captureRequirements({ ...snapshot, parentId: 'old-version', constraints: '', refs: [{ ...ref, role: 'base', versionId: 'old-version' }] }, '背景再亮一点', inherited);
  assert.equal(branch.values.constraints, '保留蓝色 Logo');
  assert.equal(branch.sources.constraints.versionId, 'old-version');
  assert.equal(branch.values.baseId, 'base');
  assert.deepEqual(inherited, saved);
  assert.equal(branch.legacy, false);
  assert.equal(captureRequirements({ ...snapshot, parentId: 'old-version' }, '把 Logo 改成红色', inherited).requiresReview, true);
});
test('A03 user reference assignments are independent of model suggestions and mask follows its base', () => {
  const locks = captureRequirements({ ...snapshot, refs: [{ ...ref, role: 'style', userRole: 'subject', userNote: '仅产品' }] }, '产品图');
  assert.equal(locks.references[0].role, 'subject');
  assert.equal(locks.references[0].note, '仅产品');
  assert.ok(executionIssues({ ...plan, operation: 'local', baseId: 'base' }, snapshot).some((issue) => issue.includes('划选')));
  assert.ok(executionIssues({ ...plan, operation: 'local', baseId: 'base' }, { ...snapshot, mask: { assetId: 'other' } }).some((issue) => issue.includes('冲突')));
});
test('A04 crop requires a base and single output, outpaint requires an explicit layout', () => {
  assert.equal(executionIssues({ ...plan, operation: 'crop', baseId: 'base' }, snapshot).length, 0);
  assert.ok(executionIssues({ ...plan, operation: 'crop', count: 2 }, snapshot).length >= 2);
  assert.ok(executionIssues({ ...plan, operation: 'outpaint', baseId: 'base' }, snapshot).some((issue) => issue.includes('方向')));
});
test('A05 exact copy keeps whitespace, case and punctuation; output checks do not certify visual quality', () => {
  const locks = captureRequirements(snapshot, '逐字英文文案「  Kit: USB-C + HDMI!  」');
  assert.equal(locks.values.exactText, '  Kit: USB-C + HDMI!  ');
  assert.ok(requirementConflicts({ ...plan, exactText: 'kit: USB-C + HDMI!' }, locks).some((x) => x.field === 'exactText'));
  const problems = compareOutput({ width: 1536, height: 1024, format: 'jpeg', count: 2 }, plan);
  assert.equal(problems.length, 3);
});
test('E01 approval is a fixed snapshot; any output or reference edit changes its signature', () => {
  const run = { requirements: captureRequirements(snapshot, '1 张主图') };
  const confirmed = confirmedRequirements(run, plan);
  const signature = planSignature(plan);
  run.requirements.values.constraints = 'later draft';
  assert.equal(confirmed.values.constraints, 'Logo 保持原样');
  assert.notEqual(signature, planSignature({ ...plan, count: 2 }));
  assert.notEqual(signature, planSignature({ ...plan, referenceRoles: [] }));
});
test('E04 automatic mode pauses for conflicts, missing masks, legacy records, changed scope or unknown price', () => {
  const run = { requirements: captureRequirements(snapshot, '1 张主图'), snapshot, costLimit: 1, planConflicts: [] };
  const options = { automatic: true, previouslyConfirmed: true, previousScope: automationScope(run, plan, 0.1) };
  assert.equal(automaticEligible(run, plan, 0.1, options), true);
  assert.equal(automaticEligible(run, { ...plan, count: 2 }, 0.1, options), false);
  assert.equal(automaticEligible(run, plan, null, options), false);
  assert.equal(automaticEligible(run, plan, 0.2, options), false);
  assert.equal(automaticEligible({ ...run, planConflicts: [{}] }, plan, 0.1, options), false);
  assert.equal(automaticEligible({ ...run, requirements: { ...run.requirements, legacy: true } }, plan, 0.1, options), false);
});
test('A06/A08 refresh and import never resume paid requests and preserve successful versions', () => {
  const tasks = [{ id: 'success', agentRunId: 'run', status: 'success' }, { id: 'queued', agentRunId: 'run', status: 'queued' }];
  const run = { id: 'run', status: 'queued', requests: 1 };
  recoverAgentSession(run, tasks);
  assert.equal(run.status, 'unknown');
  assert.equal(tasks[0].status, 'success');
  assert.equal(tasks[1].status, 'cancelled');
  const imported = recoverAgentSession({ id: 'old', status: 'review' }, [], true);
  assert.equal(imported.status, 'cancelled');
});
test('E02 partial completion retains usable results and unresolved tasks keep verification state', () => {
  state.tasks = [{ id: 'ok', status: 'success', agentRunId: 'r' }, { id: 'bad', status: 'failed', agentRunId: 'r' }];
  state.agentRuns = [{ id: 'r', status: 'running' }];
  syncAgentRuns();
  assert.equal(state.agentRuns[0].status, 'partial');
  assert.deepEqual(state.agentRuns[0].resultIds, ['ok']);
  state.agentRuns[0].status = 'running'; state.tasks[1].status = 'unknown';
  syncAgentRuns();
  assert.equal(state.agentRuns[0].status, 'unknown');
  state.tasks = []; state.agentRuns = [];
});
