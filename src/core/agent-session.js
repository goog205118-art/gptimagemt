import { SESSION_VERSION, captureRequirements } from '../../shared/agent-requirements.js';

// Safe both on refresh and backup import. An issued request is never resumed.
export function recoverAgentSession(run, tasks, imported = false) {
  run.schemaVersion ||= SESSION_VERSION;
  run.requestLog ||= [];
  run.answers ||= [];
  if (run.snapshot && !run.requirements) {
    run.requirements = captureRequirements(run.snapshot, run.request || '');
    run.requirements.legacy = true;
    if (run.plan?.decision === 'ready') {
      run.plan.operation ||= run.snapshot.mask ? (run.snapshot.mask.kind === 'outpaint' ? 'outpaint' : 'local') : run.snapshot.parentId ? 'edit' : 'create';
      run.plan.baseId ??= run.snapshot.refs.find((ref) => ref.role === 'base')?.id || '';
      run.plan.exactText ||= '';
    }
    if (run.context) run.context.requirements = run.requirements;
  }
  if (imported || ['submitting', 'running', 'queued', 'checking', 'planning'].includes(run.status)) {
    const sent = tasks.some((task) => task.agentRunId === run.id && (task.agentRequests || task.status === 'unknown')) || run.requests > 0;
    const unresolved = tasks.some((task) => task.agentRunId === run.id && ['running', 'unknown'].includes(task.status)) || run.status === 'unknown' || (sent && ['running', 'queued', 'checking'].includes(run.status));
    run.status = unresolved ? 'unknown' : imported ? 'cancelled' : 'failed';
    run.stopped = true;
    run.error = unresolved ? '会话已中断，请核实已发送请求和成功结果；不会自动重发。' : '会话已恢复，查看记录后可手动重新规划。';
    for (const task of tasks.filter((task) => task.agentRunId === run.id)) {
      if (['queued', 'retry_wait'].includes(task.status)) {
        task.status = 'cancelled';
        task.error = '会话已中断，未提交的后续步骤已停止。';
      }
    }
  }
  return run;
}
