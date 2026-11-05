import { $, icon } from '../core/dom.js';
import { state } from '../core/state.js';
import { persist, storageSet } from '../core/storage.js';
import { uid, escapeHTML } from '../core/utils.js';
import { ROLE_NAMES } from '../core/config.js';
import { AGENT_MODEL, AGENT_STATUSES, normalizePlan } from '../../shared/agent-protocol.js';
import {
  AGENT_CONNECTION_KEY,
  agentQuery,
  agentCredentials,
  getAgentConnection,
  setAgentConnection,
  referencePreviews,
} from '../services/agent.js';
import {
  gptProfile,
  gptModelLabel,
  validateGptTask,
  setGptModelInventory,
} from '../services/models.js';
import { splitGptModel } from '../../shared/model-ids.js';
import { fetchGptModelCatalog } from '../services/connection.js';
import { money, priceFor } from '../services/pricing.js';
import {
  readDraft,
  restoreDraft,
  scheduleDraft,
  focusComposer,
  updateSend,
  setComposerMode,
} from './composer.js';
import { effectivePrompt, enqueueAgentTasks, cancelTask } from './jobs.js';
import { render } from './gallery.js';
import { guard, notify, showDialog, setStatus } from '../ui/dialogs.js';
import { revealContent } from '../ui/motion.js';
import { syncPickers } from '../ui/pickers.js';

const planners = new Map();
let editingRunId = null,
  executing = false;
const runById = (id) => state.agentRuns.find((run) => run.id === id);
function options() {
  return {
    maxRequests: 3,
    costLimit: null,
    candidates: [],
    automatic: false,
    ...state.prefs.agentOptions,
  };
}
function modelInventory() {
  return state.prefs.gptCatalog?.base === state.base ? state.prefs.gptCatalog.ids : [];
}
function availableModels(ids, snapshot) {
  return ids
    .map((id) => {
      const profile = gptProfile(id);
      const sizes = [
        'auto',
        '1024x1024',
        '1536x1024',
        '1024x1536',
        '1024x1792',
        '2048x2048',
        '2048x1152',
        '3840x2160',
      ];
      if (!sizes.includes(snapshot.settings.size)) sizes.push(snapshot.settings.size);
      return {
        id,
        qualities: profile.qualities,
        maxPrompt: profile.maxPrompt,
        maxRefs: profile.maxRefs,
        sizes: sizes.filter((size) => {
          try {
            validateGptTask({
              prompt: '验证',
              constraints: '',
              refs: snapshot.refs,
              settings: {
                ...snapshot.settings,
                model: id,
                route: '',
                quality: 'medium',
                size,
              },
              effectivePrompt: '验证',
            });
            return true;
          } catch {
            return false;
          }
        }),
      };
    })
    .filter((model) => model.maxRefs >= snapshot.refs.length && model.sizes.length);
}
function planTask(run, plan, model = plan.model) {
  const settings = {
    ...run.snapshot.settings,
    model,
    route: '',
    size: plan.size,
    quality: plan.quality,
    format: plan.format,
    background: plan.background,
    timeout: Math.max(run.snapshot.settings.timeout, gptProfile(model).timeout),
  };
  const refs = run.snapshot.refs.map((ref) => ({
    ...ref,
    ...plan.referenceRoles.find((role) => role.id === ref.id),
  }));
  const task = {
    prompt: plan.prompt,
    constraints: [run.snapshot.constraints, plan.constraints].filter(Boolean).join('\n'),
    settings,
    refs,
    mask: run.snapshot.mask,
    variant: '',
  };
  task.effectivePrompt = effectivePrompt(task);
  validateGptTask(task);
  return task;
}
function compatibleCandidates(run, plan) {
  const core = splitGptModel(plan.model).core;
  return (run.allowedCandidates || [])
    .filter((id) => id !== plan.model)
    .filter((id) => {
      try {
        planTask(run, plan, id);
        return true;
      } catch {
        return false;
      }
    })
    .sort(
      (a, b) => Number(splitGptModel(b).core === core) - Number(splitGptModel(a).core === core),
    );
}
function planPrice(run, plan) {
  return priceFor({ model: plan.model, route: '' });
}
function validateExecution(run, plan, automatic = false) {
  if (run.stopped || run.status !== 'review') throw new Error('此方案已经执行或停止。');
  if (!state.key || state.base !== run.snapshot.settings.base)
    throw new Error('生图连接已变化，请重新规划。');
  const normalized = normalizePlan(plan, run.context);
  const task = planTask(run, normalized);
  const price = planPrice(run, normalized);
  if (run.currency !== state.prefs.currency) throw new Error('价格币种已改变，请重新规划。');
  if (run.costLimit !== null && (price === null || normalized.count * price > run.costLimit + 1e-8))
    throw new Error(
      price === null
        ? '请先填写此模型单价，或清空费用上限后手动确认首次生成。'
        : '方案超过估算费用上限，请减少张数或调整参数。',
    );
  if (automatic && (run.costLimit === null || price === null || !state.prefs.agentConfirmed))
    throw new Error('自动执行需要先确认一次方案，并配置模型价格和费用上限。');
  return { plan: normalized, task };
}
async function execute(run, plan, automatic = false) {
  if (executing) return;
  executing = true;
  try {
    const approved = validateExecution(run, plan, automatic);
    run.plan = approved.plan;
    run.candidates = compatibleCandidates(run, run.plan);
    run.prices = Object.fromEntries(
      [run.plan.model, ...run.candidates].map((id) => [id, priceFor({ model: id, route: '' })]),
    );
    run.requests = 0;
    run.usedEstimate = 0;
    run.requestLog = [];
    run.error = '';
    try {
      await enqueueAgentTasks(run, run.plan, approved.task.settings, approved.task.refs);
    } catch (e) {
      run.status = run.stopped ? 'cancelled' : 'review';
      throw e;
    }
    state.prefs.agentConfirmed = true;
    if (editingRunId === run.id && $('agentPlanDlg').open) $('agentPlanDlg').close();
    await persist();
    render();
    setStatus('Agent 方案已提交，后续请求受本次次数和估算费用上限约束。');
  } finally {
    executing = false;
  }
}
async function planRun(run) {
  if (planners.has(run.id)) return;
  const controller = new AbortController();
  planners.set(run.id, controller);
  run.status = 'planning';
  run.error = '';
  render();
  await persist();
  const timer = setTimeout(() => controller.abort(), 115000);
  const imageBase = state.base,
    imageKey = state.key;
  try {
    const credentials = agentCredentials();
    if (!modelInventory().length) {
      const catalog = await fetchGptModelCatalog(state.base, state.key);
      controller.signal.throwIfAborted();
      if (state.base !== imageBase || state.key !== imageKey)
        throw new Error('生图连接已变化，请重新规划。');
      setGptModelInventory(catalog.ids, state.base);
    }
    const ids = modelInventory();
    if (!ids.length) throw new Error('当前连接没有可用的 GPT 生图模型，请检查生图 Key 权限。');
    run.context = {
      request: run.request,
      originalConstraints: run.snapshot.constraints,
      currentSettings: run.snapshot.settings,
      hasMask: !!run.snapshot.mask,
      references: run.snapshot.refs.map(({ id, role, note }, i) => ({
        id,
        role,
        note,
        imageNumber: i + 1,
      })),
      availableModels: availableModels(ids, run.snapshot),
      maxRequests: run.maxRequests,
      questionsRemaining: Math.max(0, 2 - run.rounds),
      answers: run.answers,
    };
    if (!run.context.availableModels.length)
      throw new Error('当前参考图和参数没有兼容模型，请先调整手动参数。');
    const previews = await referencePreviews(run.snapshot.refs, controller.signal);
    if (state.base !== imageBase || state.key !== imageKey)
      throw new Error('生图连接已变化，请重新规划。');
    run.plannerModel = credentials.model;
    const data = await agentQuery('plan', { context: run.context, previews }, controller.signal, {
      ...credentials,
      useImageKey: false,
      apiKey: credentials.key,
    });
    controller.signal.throwIfAborted();
    if (run.stopped) return;
    run.planningUsage ||= [];
    run.planningUsage.push({ at: Date.now(), usage: data.usage });
    run.plan = normalizePlan(data.plan, run.context);
    run.status = run.plan.decision === 'clarify' ? 'questions' : 'review';
    if (run.status === 'review') planTask(run, run.plan);
    if (state.base !== imageBase || state.key !== imageKey)
      throw new Error('生图连接已变化，方案已停止，请重新规划。');
    if (run.status === 'review' && options().automatic) {
      try {
        await execute(run, run.plan, true);
        return;
      } catch (e) {
        run.error = e.message + ' 请检查后手动确认。';
      }
    }
    if (!document.querySelector('dialog[open]')) openPlan(run);
  } catch (e) {
    run.status = run.stopped ? 'cancelled' : 'failed';
    run.error = controller.signal.aborted
      ? '规划等待已停止，可能产生文本用量。不会自动重试。'
      : e.message;
  } finally {
    clearTimeout(timer);
    planners.delete(run.id);
    render();
    await persist();
  }
}
export async function startAgentPlan() {
  if (!state.ready || state.adding) return;
  if (state.editQueuedId) throw new Error('请先完成排队任务编辑，再使用 Agent。');
  const request = $('prompt').value.trim();
  if (!request && !state.refs.length) {
    focusComposer();
    throw new Error('请描述需求，或添加参考图。');
  }
  if (state.agentRuns.filter((r) => r.status === 'planning').length >= 2)
    throw new Error('已有两个方案正在规划，请稍候。');
  const snapshot = readDraft();
  const inputSignature = JSON.stringify({
    request,
    settings: snapshot.settings,
    constraints: snapshot.constraints,
    refs: snapshot.refs.map(({ id, role, note }) => ({ id, role, note })),
    mask: snapshot.mask,
  });
  if (
    state.agentRuns.some(
      (run) => run.status === 'planning' && run.inputSignature === inputSignature,
    )
  ) {
    notify('同一需求正在规划。修改需求后可以继续提交另一方案。');
    return;
  }
  try {
    agentCredentials();
  } catch (e) {
    showAgentSettings();
    throw e;
  }
  const config = options();
  const run = {
    id: uid(),
    request: request || '请先询问我希望如何处理这些参考图。',
    snapshot,
    inputSignature,
    status: 'planning',
    createdAt: Date.now(),
    rounds: 0,
    answers: [],
    maxRequests: config.maxRequests,
    costLimit: config.costLimit,
    currency: state.prefs.currency,
    allowedCandidates: [...config.candidates],
    requests: 0,
    usedEstimate: 0,
    requestLog: [],
  };
  state.agentRuns.unshift(run);
  await planRun(run);
}
function questionFields(run) {
  return run.plan.questions
    .map(
      (q, i) => `<fieldset class="agent-question"><legend>${escapeHTML(q.title)}</legend>
    <div class="agent-answer-options">${q.options.map((option, j) => `<label><input type="radio" name="answer${i}" value="${j}" ${run.pendingAnswers?.[i] === option ? 'checked' : ''}><span>${escapeHTML(option)}</span></label>`).join('')}</div>
    <label class="agent-free-answer">补充说明或直接填写<input type="text" data-answer="${i}" maxlength="1200" value="${escapeHTML(run.pendingAnswers?.[i] || '')}" placeholder="填写你的想法…"></label></fieldset>`,
    )
    .join('');
}
function fillPlanOptions(plan, run) {
  const profile = run.context.availableModels.find((m) => m.id === plan.model);
  if (!profile) return;
  for (const [field, values, selected] of [
    ['agentPlanSize', profile.sizes, plan.size],
    ['agentPlanQuality', profile.qualities, plan.quality],
  ]) {
    $(field).innerHTML = values
      .map(
        (value) =>
          `<option value="${value}">${escapeHTML({ low: '预览', medium: '标准', high: '精细', xhigh: '超清', max: '极致', auto: '自动' }[value] || value)}</option>`,
      )
      .join('');
    $(field).value = values.includes(selected) ? selected : values[0];
  }
  $('agentPlanSize').disabled = !!run.snapshot.mask;
  syncPickers();
}
function formPlan(run) {
  return {
    ...run.plan,
    model: $('agentPlanModel').value,
    size: $('agentPlanSize').value,
    quality: $('agentPlanQuality').value,
    count: Number($('agentPlanCount').value),
    prompt: $('agentPlanPrompt').value,
    constraints: $('agentPlanConstraints').value,
  };
}
function updatePlanEstimate() {
  const run = runById(editingRunId);
  if (!run || run.status !== 'review') return;
  const plan = formPlan(run),
    price = planPrice(run, plan);
  $('agentPlanEstimate').textContent =
    `${plan.count} 张 · ${price === null ? '未填写单价，无法估价' : '首次生成估算 ' + money(price * plan.count, run.currency)} · 最多 ${run.maxRequests} 次请求${run.costLimit === null ? '；不自动重试' : '，估算上限 ' + money(run.costLimit, run.currency)}。规划文本费用另计。`;
  const candidates = compatibleCandidates(run, plan);
  $('agentPlanFallbacks').textContent = candidates.length
    ? '允许的兼容备用：' + candidates.map(gptModelLabel).join('、')
    : '本次没有兼容且已授权的备用模型 / 线路。';
}
function openPlan(run) {
  if (!['questions', 'review'].includes(run.status)) return;
  editingRunId = run.id;
  const questioning = run.status === 'questions';
  $('agentPlanTitle').textContent = questioning ? '补充几个关键点' : '确认创作方案';
  $('agentPlanSummary').textContent = run.plan.summary;
  $('agentPlanError').textContent = run.error || '';
  $('agentPlanFields').hidden = questioning;
  $('agentQuestions').hidden = !questioning;
  $('agentQuestions').innerHTML = questioning ? questionFields(run) : '';
  $('agentImportPlan').hidden = questioning;
  $('agentExecute').textContent = questioning ? '补充并继续规划' : '确认并生成';
  $('agentExecute').disabled = false;
  if (!questioning) {
    const plan = run.plan;
    $('agentPlanPrompt').value = plan.prompt;
    $('agentPlanConstraints').value = plan.constraints;
    $('agentPlanModel').innerHTML = run.context.availableModels
      .map((m) => `<option value="${m.id}">${escapeHTML(gptModelLabel(m.id))}</option>`)
      .join('');
    $('agentPlanModel').value = plan.model;
    $('agentPlanCount').value = plan.count;
    $('agentPlanCount').max = run.maxRequests;
    fillPlanOptions(plan, run);
    $('agentPlanReferences').textContent = plan.referenceRoles.length
      ? '参考图用途：' +
        plan.referenceRoles
          .map(
            (ref, i) =>
              `${i + 1} · ${ROLE_NAMES[ref.role]}${ref.note ? '（' + ref.note + '）' : ''}`,
          )
          .join('；')
      : '不使用参考图。';
    updatePlanEstimate();
  }
  showDialog('agentPlanDlg');
}
export function renderAgentRuns() {
  const root = $('agentRuns');
  if (!root) return;
  const runs = state.agentRuns
    .filter(
      (run) =>
        !run.dismissed &&
        (state.projectFilter === 'all' || run.snapshot?.projectId === state.projectFilter),
    )
    .sort((a, b) => {
      const rank = (run) =>
        ['review', 'questions'].includes(run.status)
          ? 0
          : ['planning', 'running'].includes(run.status)
            ? 1
            : ['unknown', 'failed'].includes(run.status)
              ? 2
              : 3;
      return rank(a) - rank(b) || b.createdAt - a.createdAt;
    });
  const current = runs.find((run) =>
    ['questions', 'review', 'failed', 'unknown', 'planning', 'running'].includes(run.status),
  );
  root.hidden = !current;
  $('agentHistoryBtn').hidden = !runs.length;
  $('agentHistoryBtn').textContent = `Agent 记录 · ${runs.length}`;
  const signature = JSON.stringify(
    runs.map((r) => [
      r.id,
      r.status,
      r.error,
      r.requests,
      r.usedEstimate,
      r.plan?.summary,
      r.requestLog?.map((item) => item.outcome),
    ]),
  );
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.innerHTML = current
    ? `<article class="agent-run agent-status-line" data-agent-run="${current.id}" data-agent-state="${current.status}">
    <strong>${['planning', 'running'].includes(current.status) ? '<span class="spinner"></span>' : icon('mark')} Agent · ${AGENT_STATUSES[current.status]}</strong>
    <span class="agent-run-summary" title="${escapeHTML(current.error || current.request)}">${escapeHTML(current.error || current.request)}</span>
    <div class="agent-line-actions">${['questions', 'review'].includes(current.status) ? '<button class="btn primary" data-agent-action="review">' + (current.status === 'questions' ? '补充需求' : '确认方案') + '</button>' : ''}
    ${['planning', 'running'].includes(current.status) ? '<button class="btn" data-agent-action="stop">停止</button>' : ''}
    <button class="btn" data-agent-action="history">${runs.length > 1 ? runs.length + ' 条记录' : '查看记录'}</button></div></article>`
    : '';
  const expanded = new Set(
    Array.from(
      $('agentHistoryList').querySelectorAll('[data-agent-run] details[open]'),
      (el) => el.closest('[data-agent-run]').dataset.agentRun,
    ),
  );
  const focused = $('agentHistoryList').contains(document.activeElement)
    ? {
        runId: document.activeElement.closest('[data-agent-run]')?.dataset.agentRun,
        action: document.activeElement.dataset.agentAction,
        details: document.activeElement.matches('summary'),
      }
    : null;
  const scrollTop = $('agentHistoryList').scrollTop;
  $('agentHistoryList').innerHTML = runs
    .map(
      (
        run,
      ) => `<article class="agent-record" data-agent-run="${run.id}" data-agent-state="${run.status}">
    <div class="agent-run-heading"><strong>${['planning', 'running'].includes(run.status) ? '<span class="spinner"></span>' : icon('mark')} Agent · ${AGENT_STATUSES[run.status] || '已停止'}</strong><div>${['planning', 'running', 'questions', 'review'].includes(run.status) ? '<button class="btn" data-agent-action="stop">停止</button>' : ''}<button class="icon-btn" data-agent-action="dismiss" aria-label="隐藏方案记录">${icon('close')}</button></div></div>
    <p class="agent-run-request">${escapeHTML(run.request)}</p>
    ${['failed', 'unknown'].includes(run.status) ? '<p class="agent-run-summary">' + escapeHTML(run.error || '查看图片卡片与执行记录。') + '</p>' : ''}
    <div class="agent-run-footer"><span>${run.requests || 0}/${run.maxRequests} 次生图请求${run.usedEstimate ? ' · 已预留估算 ' + money(run.usedEstimate, run.currency) : ''}</span><div>
    ${['questions', 'review'].includes(run.status) ? '<button class="btn primary" data-agent-action="review">' + (run.status === 'questions' ? '补充需求' : '查看并确认方案') + '</button>' : ''}
    ${run.status !== 'planning' ? '<button class="btn" data-agent-action="import">导入输入框</button>' : ''}
    ${run.status === 'failed' ? '<button class="btn" data-agent-action="replan">手动重新规划</button>' : ''}</div></div>
    <details class="agent-execution" ${expanded.has(run.id) ? 'open' : ''}><summary>方案与执行记录</summary><p>${escapeHTML(run.request)}</p><p>${escapeHTML(run.error || run.plan?.summary || '')}</p><p>规划模型：${escapeHTML(run.plannerModel || getAgentConnection().model)} · 规划 ${run.planningUsage?.length || 0} 轮</p>
    ${run.plan?.decision === 'ready' ? `<p>${escapeHTML(run.plan.model)} · ${escapeHTML(run.plan.size)} · ${escapeHTML(run.plan.quality)} · ${run.plan.count} 张</p><p>${escapeHTML(run.plan.prompt)}</p>` : ''}
    <ol>${(run.requestLog || []).map((item) => `<li>${escapeHTML(item.model)} · ${escapeHTML({ success: '成功', failed: '失败', unknown: '结果待核实', limited: '限流', unavailable: '不可用，切换候选' }[item.outcome] || '已提交')} · ${item.estimate == null ? '无价格估算' : '预留估算 ' + money(item.estimate, run.currency)}</li>`).join('')}</ol></details></article>`,
    )
    .join('');
  if (focused?.runId) {
    const row = Array.from($('agentHistoryList').querySelectorAll('[data-agent-run]')).find(
      (el) => el.dataset.agentRun === focused.runId,
    );
    const target = focused.details
      ? row?.querySelector('summary')
      : Array.from(row?.querySelectorAll('[data-agent-action]') || []).find(
          (el) => el.dataset.agentAction === focused.action,
        );
    (
      target ||
      row?.querySelector('summary') ||
      $('agentHistoryDlg').querySelector('[data-close]')
    )?.focus({ preventScroll: true });
  }
  $('agentHistoryList').scrollTop = scrollTop;
  if (root.firstElementChild) revealContent(root.firstElementChild);
}
function settingsValue() {
  const useImageKey = $('agentReuseKey').checked;
  const value = {
    useImageKey,
    model: $('agentModel').value.trim(),
    strict: $('agentStrict').value === 'strict',
    base: $('agentBase').value.trim() || 'https://api.openlux.ai/v1',
    apiKey: useImageKey ? '' : $('agentKey').value.trim(),
  };
  if (!/^gpt-[a-zA-Z0-9._-]{1,120}$/.test(value.model))
    throw new Error('请填写有效的规划模型 ID。');
  if (!useImageKey) {
    const url = new URL(value.base);
    if (
      !['https://api.openlux.ai/v1', 'https://api.openlux.uk/v1'].includes(
        url.href.replace(/\/$/, ''),
      )
    )
      throw new Error('请选择 OpenLux 官方 /v1 地址。');
    if (!value.apiKey || /\s/.test(value.apiKey) || value.apiKey.length > 16000)
      throw new Error('请填写有效的 Agent API Key。');
    value.base = url.href.replace(/\/$/, '');
  }
  return value;
}
function showAgentSettings() {
  const config = getAgentConnection(),
    prefs = options();
  $('agentReuseKey').checked = config.useImageKey;
  $('agentSeparateConnection').hidden = config.useImageKey;
  $('agentBase').value = config.base || 'https://api.openlux.ai/v1';
  $('agentKey').value = config.apiKey || '';
  $('agentModel').value = config.model || AGENT_MODEL;
  $('agentStrict').value = config.strict ? 'strict' : 'json';
  $('agentRemember').checked = true;
  $('agentMaxRequests').value = prefs.maxRequests;
  $('agentCostLimit').value = prefs.costLimit ?? '';
  $('agentCostLabel').textContent = `每个方案估算上限（${state.prefs.currency}）`;
  $('agentAutomatic').checked = prefs.automatic;
  $('agentConnectionStatus').textContent = '';
  $('agentCandidates').innerHTML =
    modelInventory()
      .map(
        (id) =>
          `<label class="check"><input type="checkbox" value="${id}" ${prefs.candidates.includes(id) ? 'checked' : ''}><span>${escapeHTML(gptModelLabel(id))}</span></label>`,
      )
      .join('') || '<p class="agent-help">先在 API 设置读取生图模型清单，再回来选择备用。</p>';
  syncPickers();
  showDialog('agentSettingsDlg');
}
async function stopRun(run) {
  run.stopped = true;
  planners.get(run.id)?.abort();
  for (const task of state.tasks.filter((t) => t.agentRunId === run.id)) cancelTask(task);
  if (run.status !== 'running') run.status = 'cancelled';
  run.error = '后续步骤已停止；已经提交的请求可能仍在服务端处理。';
  if (editingRunId === run.id && $('agentPlanDlg').open) $('agentPlanDlg').close();
  render();
  await persist();
}
export function mountAgent() {
  $('agentHistoryBtn').onclick = () => showDialog('agentHistoryDlg');
  $('agentModeBtn').onclick = () => {
    if (state.agentMode) return;
    setComposerMode(true);
    setStatus('Agent 会先规划与补问，确认方案后才生图。');
  };
  $('manualModeBtn').onclick = () => {
    setComposerMode(false);
    setStatus('已切换手动模式，可以自行调整生成参数。');
  };
  $('agentSettingsBtn').onclick = showAgentSettings;
  $('agentReuseKey').onchange = () => {
    $('agentSeparateConnection').hidden = $('agentReuseKey').checked;
  };
  $('agentSettingsForm').onsubmit = guard(async (e) => {
    e.preventDefault();
    const config = settingsValue();
    const maxRequests = Number($('agentMaxRequests').value),
      rawCost = $('agentCostLimit').value,
      costLimit = rawCost === '' ? null : Number(rawCost);
    if (
      !Number.isInteger(maxRequests) ||
      maxRequests < 1 ||
      maxRequests > 3 ||
      (costLimit !== null && (!Number.isFinite(costLimit) || costLimit <= 0))
    )
      throw new Error('请检查请求数和费用上限。');
    if (
      !storageSet(AGENT_CONNECTION_KEY, $('agentRemember').checked ? JSON.stringify(config) : null)
    )
      throw new Error('浏览器未能保存 Agent 连接。');
    const old = getAgentConnection();
    if (
      ['useImageKey', 'model', 'base', 'apiKey', 'strict'].some((key) => old[key] !== config[key])
    )
      state.prefs.agentConfirmed = false;
    setAgentConnection(config);
    state.prefs.agentOptions = {
      maxRequests,
      costLimit,
      automatic: $('agentAutomatic').checked,
      candidates: Array.from(
        $('agentCandidates').querySelectorAll('input:checked'),
        (el) => el.value,
      ),
    };
    await persist();
    updateSend();
    $('agentSettingsDlg').close();
    notify('Agent 设置已保存。');
  });
  const check = async (paid) => {
    $('agentConnectionStatus').textContent = paid ? '正在测试规划…' : '正在读取模型清单…';
    $('agentCheckModel').disabled = $('agentTestPlan').disabled = true;
    try {
      const config = settingsValue();
      if (paid) {
        const snapshot = readDraft();
        const context = {
          request: '极简白色陶瓷杯产品摄影。请直接给方案，不补问。',
          references: [],
          currentSettings: snapshot.settings,
          availableModels: availableModels(modelInventory(), { ...snapshot, refs: [] }),
          hasMask: false,
          maxRequests: 1,
          questionsRemaining: 0,
          answers: [],
        };
        if (!context.availableModels.length) throw new Error('请先读取生图模型清单。');
        const data = await agentQuery('plan', { context, previews: [] }, undefined, config);
        normalizePlan(data.plan, context);
        $('agentConnectionStatus').textContent =
          '文本规划与结构化输出测试通过；尚未验证参考图理解和真实生图。';
      } else {
        const data = await agentQuery('models', {}, undefined, config);
        $('agentConnectionStatus').textContent = data.visible
          ? '模型在当前 Key 清单中可见。实际规划、图片输入能力仍需请求验证。'
          : '当前 Key 清单中没有此模型，请检查 OpenLux 的模型 ID 和权限。';
      }
    } catch (e) {
      $('agentConnectionStatus').textContent = e.message;
    } finally {
      $('agentCheckModel').disabled = $('agentTestPlan').disabled = false;
    }
  };
  $('agentCheckModel').onclick = () => check(false);
  $('agentTestPlan').onclick = () => check(true);
  const activityAction = guard(async (e) => {
    const button = e.target.closest('[data-agent-action]'),
      run = runById(button?.closest('[data-agent-run]')?.dataset.agentRun);
    if (!run || !button) return;
    const action = button.dataset.agentAction;
    if (action === 'history') showDialog('agentHistoryDlg');
    if (action === 'review') {
      $('agentHistoryDlg').close();
      openPlan(run);
    }
    if (action === 'stop') await stopRun(run);
    if (action === 'dismiss') {
      if (['planning', 'running', 'questions', 'review'].includes(run.status)) await stopRun(run);
      run.dismissed = true;
      render();
      await persist();
    }
    if (action === 'import') importRun(run);
    if (action === 'replan') {
      $('agentHistoryDlg').close();
      run.rounds = 0;
      run.answers = [];
      run.stopped = false;
      await planRun(run);
    }
  });
  $('agentRuns').onclick = activityAction;
  $('agentHistoryList').onclick = activityAction;
  $('agentQuestions').onchange = (e) => {
    const run = runById(editingRunId);
    if (!run) return;
    run.pendingAnswers ||= [];
    const radio = e.target.closest('input[type=radio]');
    if (radio) {
      const i = Number(radio.name.replace('answer', ''));
      run.pendingAnswers[i] = run.plan.questions[i].options[Number(radio.value)];
      $('agentQuestions').querySelector(`[data-answer="${i}"]`).value = run.pendingAnswers[i];
    }
    persist();
  };
  $('agentQuestions').oninput = (e) => {
    const run = runById(editingRunId);
    if (!run || !e.target.matches('[data-answer]')) return;
    run.pendingAnswers ||= [];
    run.pendingAnswers[Number(e.target.dataset.answer)] = e.target.value;
    e.target
      .closest('fieldset')
      .querySelectorAll('input[type=radio]')
      .forEach((el) => {
        el.checked = false;
      });
  };
  $('agentPlanModel').onchange = () => {
    const run = runById(editingRunId);
    if (!run) return;
    fillPlanOptions(formPlan(run), run);
    updatePlanEstimate();
  };
  $('agentPlanForm').addEventListener('input', () => {
    const run = runById(editingRunId);
    if (run?.status === 'review') {
      run.plan = formPlan(run);
      updatePlanEstimate();
    }
  });
  $('agentPlanForm').addEventListener('change', () => {
    const run = runById(editingRunId);
    if (run?.status === 'review') {
      run.plan = formPlan(run);
      updatePlanEstimate();
    }
  });
  $('agentPlanDlg').addEventListener('close', () => {
    persist();
  });
  $('agentPlanForm').onsubmit = async (e) => {
    e.preventDefault();
    const run = runById(editingRunId);
    if (!run || !['questions', 'review'].includes(run.status)) return;
    $('agentExecute').disabled = true;
    $('agentPlanError').textContent = '';
    try {
      if (run.status === 'questions') {
        const answers = run.plan.questions.map((q, i) => ({
          question: q.title,
          answer: $('agentQuestions').querySelector(`[data-answer="${i}"]`).value.trim(),
        }));
        if (answers.some((a) => !a.answer)) throw new Error('请补充每个问题，或填写你的想法。');
        run.answers.push(...answers);
        run.rounds++;
        run.pendingAnswers = [];
        $('agentPlanDlg').close();
        await planRun(run);
      } else await execute(run, formPlan(run));
    } catch (e) {
      $('agentPlanError').textContent = e.message;
    } finally {
      $('agentExecute').disabled = false;
    }
  };
  $('agentImportPlan').onclick = () => {
    const run = runById(editingRunId);
    if (run) importRun(run);
  };
}
function importRun(run) {
  const draft = structuredClone(run.snapshot);
  if (run.plan?.decision === 'ready') {
    const plan = run.plan;
    draft.prompt = plan.prompt;
    draft.constraints = [draft.constraints, plan.constraints].filter(Boolean).join('\n');
    draft.settings = {
      ...draft.settings,
      model: plan.model,
      route: '',
      size: plan.size,
      quality: plan.quality,
      format: plan.format,
      background: plan.background,
    };
    draft.refs = draft.refs.map((ref) => ({
      ...ref,
      ...plan.referenceRoles.find((r) => r.id === ref.id),
    }));
    draft.n = plan.count;
  }
  draft.editQueuedId = null;
  draft.variantAxis = '';
  draft.variants = '';
  restoreDraft(draft);
  setComposerMode(false);
  scheduleDraft();
  focusComposer();
  updateSend();
  setStatus('已导入方案和原始参考素材，可手动编辑后生成。');
}
