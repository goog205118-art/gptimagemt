import { state } from './state.js';
import { recoverableRejection } from '../../shared/agent-protocol.js';

const scopes = new Map();
export const agentRunFor = (task) => state.agentRuns.find((run) => run.id === task.agentRunId);
export function authorizeAgentRun(run) {
  scopes.set(run.id, { base: state.base, key: state.key });
}
export function reserveAgentRequest(task) {
  if (!task.agentRunId) return;
  const run = agentRunFor(task),
    scope = scopes.get(task.agentRunId);
  if (
    !run ||
    run.stopped ||
    !scope ||
    scope.base !== task.settings.base ||
    scope.base !== state.base ||
    scope.key !== state.key
  )
    throw new Error('Agent 执行已暂停或连接已改变。请重新确认方案。');
  if (run.requests >= run.maxRequests) throw new Error('已达到本次 Agent 生图请求上限。');
  const id = task.settings.model + task.settings.route;
  const price = run.prices[id];
  if (run.costLimit !== null && (price == null || run.usedEstimate + price > run.costLimit + 1e-8))
    throw new Error(
      price == null
        ? '当前模型没有价格，无法在费用上限内自动执行。'
        : '已达到本次 Agent 估算费用上限。',
    );
  if ((task.agentRequests || 0) > 0 && (price == null || run.costLimit === null))
    throw new Error('自动重试需要设置模型价格和本次估算费用上限。');
  run.requests++;
  run.usedEstimate += price ?? 0;
  task.agentRequests = (task.agentRequests || 0) + 1;
  run.requestLog.push({ taskId: task.id, model: id, at: Date.now(), estimate: price ?? null,
    operation: task.operation, baseAssetId: task.baseAssetId, parentId: task.parentId, planRevision: task.approval?.revision });
}
export function agentCanRetry(task, nextPrice) {
  if (!task.agentRunId) return true;
  const run = agentRunFor(task);
  const pending = state.tasks.filter(
    (t) =>
      t.agentRunId === run?.id &&
      t.id !== task.id &&
      !t.agentRequests &&
      ['queued', 'running', 'retry_wait'].includes(t.status),
  );
  const initialReserve = pending.reduce(
    (sum, t) => sum + (run?.prices[t.settings.model + t.settings.route] ?? Infinity),
    0,
  );
  const price = nextPrice ?? run?.prices[task.settings.model + task.settings.route];
  return (
    !!run &&
    !run.stopped &&
    run.requests + pending.length < run.maxRequests &&
    run.costLimit !== null &&
    price != null &&
    run.usedEstimate + price + initialReserve <= run.costLimit + 1e-8
  );
}
export function nextAgentCandidate(task, status, payload, validate) {
  const run = agentRunFor(task);
  if (!run || !agentCanRetry(task, 0) || !recoverableRejection(status, payload)) return null;
  const current = task.settings.model + task.settings.route;
  task.agentTried ||= [current];
  for (const candidate of run.candidates) {
    if (task.agentTried.includes(candidate)) continue;
    const health =
      state.prefs.agentHealth?.[
        `${task.settings.base}|${candidate}|${task.mask ? 'mask' : task.refs.length ? 'edit' : 'generate'}`
      ];
    if (health?.cooldownUntil > Date.now()) continue;
    const price = run.prices[candidate];
    const pendingReserve = state.tasks
      .filter(
        (t) =>
          t.agentRunId === run.id &&
          t.id !== task.id &&
          !t.agentRequests &&
          ['queued', 'running', 'retry_wait'].includes(t.status),
      )
      .reduce((sum, t) => sum + (run.prices[t.settings.model + t.settings.route] ?? Infinity), 0);
    if (price == null || run.usedEstimate + price + pendingReserve > run.costLimit + 1e-8) continue;
    const settings = { ...task.settings, model: candidate, route: '' };
    try {
      const profile = validate({ ...task, settings });
      settings.timeout = Math.max(settings.timeout || 300, profile?.timeout || 300);
    } catch {
      continue;
    }
    task.agentTried.push(candidate);
    return settings;
  }
  return null;
}
export function recordAgentHealth(task, outcome, elapsedMs = 0) {
  if (!task.agentRunId) return;
  const run = agentRunFor(task);
  const request = run?.requestLog.findLast(
    (item) => item.taskId === task.id && item.at >= task.startedAt,
  );
  if (request) Object.assign(request, { outcome, elapsedMs });
  state.prefs.agentHealth ||= {};
  const id = `${task.settings.base}|${task.settings.model + task.settings.route}|${task.mask ? 'mask' : task.refs.length ? 'edit' : 'generate'}`;
  const old = state.prefs.agentHealth[id] || { successes: 0, failures: 0 };
  state.prefs.agentHealth[id] = {
    successes: old.successes + (outcome === 'success' ? 1 : 0),
    failures: old.failures + (outcome === 'success' ? 0 : 1),
    lastOutcome: outcome,
    elapsedMs,
    checkedAt: Date.now(),
    cooldownUntil: outcome === 'unavailable' ? Date.now() + 60000 : 0,
  };
  const entries = Object.entries(state.prefs.agentHealth);
  if (entries.length > 128)
    delete state.prefs.agentHealth[entries.sort((a, b) => a[1].checkedAt - b[1].checkedAt)[0][0]];
}
export function syncAgentRuns() {
  for (const run of state.agentRuns) {
    if (!['running', 'queued', 'checking'].includes(run.status)) continue;
    const tasks = state.tasks.filter((t) => t.agentRunId === run.id);
    if (tasks.some((t) => ['running', 'queued', 'retry_wait'].includes(t.status))) continue;
    run.status = tasks.some((t) => t.status === 'unknown')
      ? 'unknown'
      : tasks.length && tasks.every((t) => t.status === 'success')
        ? 'success'
        : tasks.some((t) => t.status === 'success')
          ? 'partial'
        : run.stopped
          ? 'cancelled'
          : 'failed';
    run.finishedAt = Date.now();
    run.resultIds = tasks.filter((t) => t.status === 'success').map((t) => t.id);
    if (run.status !== 'success')
      run.error ||= tasks.find((task) => task.error)?.error || '本次方案未全部完成。';
    scopes.delete(run.id);
  }
}
