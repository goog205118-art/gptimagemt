import { $, icon } from '../core/dom.js';
import { state, taskById } from '../core/state.js';
import { persist, storageSet } from '../core/storage.js';
import { uid, escapeHTML } from '../core/utils.js';
import { ROLE_NAMES } from '../core/config.js';
import { AGENT_MODEL, AGENT_STATUSES, normalizePlan } from '../../shared/agent-protocol.js';
import { agentImageSpecs, variantBrief, normalizeCompiledVariants } from '../../shared/agent-variants.js';
import { prepareGptRequest } from '../services/images.js';
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
  continueTask,
} from './composer.js';
import { effectivePrompt, enqueueAgentTasks, cancelTask } from './jobs.js';
import { render } from './gallery.js';
import { guard, notify, showDialog, setStatus } from '../ui/dialogs.js';
import { syncPickers } from '../ui/pickers.js';
import { referenceURL } from '../core/assets.js';
import { inspectOutput } from '../core/output-check.js';
import { openEditor } from './editor.js';
import { openDetail } from './detail.js';
import {
  SESSION_VERSION, OPERATIONS, captureRequirements, requirementConflicts,
  executionIssues, planSignature, confirmedRequirements, automaticEligible, automationScope,
} from '../../shared/agent-requirements.js';

const planners = new Map();
let editingRunId = null,
  executing = false,
  activityRunId = null,
  activityOpen = false;
const runById = (id) => state.agentRuns.find((run) => run.id === id);
const needsInput = (run) => ['questions', 'review'].includes(run?.status);
const inProgress = (run) => ['planning', 'submitting', 'running', 'queued', 'checking'].includes(run?.status);
const isLive = (run) => !run?.dismissed && (needsInput(run) || inProgress(run) || run?.status === 'unknown');
const latestActivity = () =>
  state.agentRuns.find((run) => isLive(run) && needsInput(run)) || state.agentRuns.find(isLive);
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
        '1024x1280', '1280x1024', '1536x1920', '1920x1536',
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
  refs.sort((a, b) => Number(b.id === plan.baseId) - Number(a.id === plan.baseId));
  const task = {
    prompt: plan.prompt,
    constraints: plan.constraints,
    exactText: plan.exactText,
    operation: plan.operation,
    baseAssetId: plan.baseId,
    parentId: plan.operation === 'create' ? null : run.snapshot.refs.find((ref) => ref.id === plan.baseId)?.versionId || run.snapshot.parentId,
    settings,
    refs,
    mask: run.snapshot.mask,
    variant: '',
  };
  task.rootId = taskById(task.parentId)?.rootId || task.parentId || null;
  const specs = agentImageSpecs(plan);
  for (const spec of specs) {
    const imageTask = { ...task, ...spec };
    imageTask.effectivePrompt = effectivePrompt(imageTask);
    if (plan.operation !== 'crop') validateGptTask(imageTask);
  }
  Object.assign(task, specs[0]);
  task.effectivePrompt = effectivePrompt(task);
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
  if (plan.operation !== 'crop' && (!state.key || state.base !== run.snapshot.settings.base))
    throw new Error('生图连接已变化，请重新规划。');
  const normalized = normalizePlan(plan, run.context);
  if (plan.variationSuggestions?.length && !run.variationSelection?.length)
    throw new Error('请先选择 AI 推荐的变化维度和细节，再确认生成。');
  if (normalized.variants.length && normalized.variantPromptMode !== 'complete')
    throw new Error('请先让 AI 编写每张完整提示词，核对后再生成。');
  if ((run.planConflicts?.length || run.requirements?.legacy || run.requirements?.requiresReview || requirementConflicts(normalized, run.requirements).length) && run.acknowledgedSignature !== planSignature(normalized))
    throw new Error('方案与用户要求或继承项有差异，请核对并确认变更。');
  const issues = executionIssues(normalized, run.snapshot);
  if (issues.length) throw new Error(issues.join('\n'));
  const task = planTask(run, normalized);
  const price = planPrice(run, normalized);
  if (run.currency !== state.prefs.currency) throw new Error('价格币种已改变，请重新规划。');
  if (normalized.operation !== 'crop' && run.costLimit !== null && (price === null || normalized.count * price > run.costLimit + 1e-8))
    throw new Error(
      price === null
        ? '请先填写此模型单价，或清空费用上限后手动确认首次生成。'
        : '方案超过估算费用上限，请减少张数或调整参数。',
    );
  if (automatic && !automaticEligible(run, normalized, price, {
    ...options(), previouslyConfirmed: state.prefs.agentConfirmed, previousScope: state.prefs.agentAutomaticScope,
  })) throw new Error('本轮范围、规格、参考用途或费用条件已变化，请重新确认。');
  return { plan: normalized, task };
}
async function execute(run, plan, automatic = false) {
  if (executing) return;
  executing = true;
  try {
    const approved = validateExecution(run, plan, automatic);
    if (run.submissionId) throw new Error('此方案已提交，请查看对应版本。');
    run.plan = approved.plan;
    run.planRevision ||= 1;
    run.approval = {
      version: SESSION_VERSION, runId: run.id, parentId: run.plan.operation === 'create' ? null : run.snapshot.refs.find((ref) => ref.id === run.plan.baseId)?.versionId || run.snapshot.parentId,
      revision: run.planRevision, signature: planSignature(run.plan),
      plan: structuredClone(run.plan), requirements: confirmedRequirements(run, run.plan), at: Date.now(),
    };
    run.submissionId = uid();
    run.status = 'submitting';
    if (editingRunId === run.id) $('agentPlanFields').inert = true;
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
      delete run.submissionId;
      throw e;
    }
    state.prefs.agentConfirmed = true;
    state.prefs.agentAutomaticScope = automationScope(run, run.plan, planPrice(run, run.plan));
    if (editingRunId === run.id && $('agentPlanDlg').open) $('agentPlanDlg').close();
    await persist();
    render();
    setStatus('Agent 方案已提交，后续请求受本次次数和估算费用上限约束。');
  } finally {
    executing = false;
    if (editingRunId === run.id) $('agentPlanFields').inert = false;
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
      variationRecommendationsRequired: true,
      independentVariantPrompts: true,
      variation: {
        axis: run.snapshot.variantAxis || '',
        options: (run.snapshot.variants || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        strength: '保持主体与共同要求，仅在指定维度内适度变化',
      },
      hasMask: !!run.snapshot.mask,
      references: run.snapshot.refs.map(({ id, role, note }, i) => ({
        id,
        role,
        note,
        imageNumber: i + 1,
      })),
      availableModels: availableModels(ids, run.snapshot),
      maxRequests: run.maxRequests,
      clarificationPreference: run.clarificationPreference || 'ask',
      clarificationRounds: run.rounds || 0,
      answers: run.answers,
      variationFeedback: run.variationFeedback || '',
      priorPlan: run.variationFeedback ? run.plan : undefined,
      requirements: run.requirements,
      selectedVersionId: run.snapshot.parentId || null,
    };
    if (!run.context.availableModels.length)
      throw new Error('当前参考图和参数没有兼容模型，请先调整手动参数。');
    const detailReferences = (run.detailReferences || []).filter((ref) => run.snapshot.refs.some((parent) => parent.id === ref.parentId));
    run.context.detailReferences = detailReferences.map(({ parentId, crop, id }, index) => ({ parentId, crop, id, imageNumber: run.snapshot.refs.length + index + 1 }));
    const previews = [
      ...await referencePreviews(run.snapshot.refs, controller.signal),
      ...await referencePreviews(detailReferences, controller.signal, 1024),
    ];
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
    delete run.variationGroup;
    delete run.variationSelection;
    delete run.variantDrafts;
    delete run.variantCompilation;
    run.planRevision = (run.planRevision || 0) + 1;
    run.planConflicts = run.plan.decision === 'ready' ? requirementConflicts(run.plan, run.requirements) : [];
    // Keep the user text intact on the card. Model wording remains an attributed suggestion.
    if (run.plan.decision === 'ready') {
      run.plan.variantPromptMode = run.plan.variants.length || run.plan.variationSuggestions.length ? 'brief' : 'delta';
      run.suggestions = { constraints: run.plan.constraints, summary: run.plan.summary };
      run.plan.constraints = run.requirements?.values.constraints || run.plan.constraints;
      run.plan.exactText = run.requirements?.values.exactText || run.plan.exactText;
    }
    run.status = run.plan.decision === 'clarify' ? 'questions' : 'review';
    if (run.status === 'review' && run.plan.variantPromptMode !== 'brief') planTask(run, run.plan);
    if (state.base !== imageBase || state.key !== imageKey)
      throw new Error('生图连接已变化，方案已停止，请重新规划。');
    if (run.status === 'review' && !run.requireManualReview && options().automatic) {
      try {
        await execute(run, run.plan, true);
        return;
      } catch (e) {
        run.error = e.message + ' 请检查后手动确认。';
      }
    }
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
  const requirements = captureRequirements(snapshot, request, taskById(snapshot.parentId)?.confirmedRequirements);
  const inputSignature = JSON.stringify({
    request,
    settings: snapshot.settings,
    constraints: snapshot.constraints,
    exactText: snapshot.exactText,
    variantAxis: snapshot.variantAxis,
    variants: snapshot.variants,
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
    schemaVersion: SESSION_VERSION,
    requirements,
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
  activityRunId = run.id;
  activityOpen = true;
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
function pendingQuestionAnswers(run) {
  return (run.plan?.decision === 'clarify' ? run.plan.questions : []).map((q, i) => ({
    question: q.title,
    answer: (run.pendingAnswers?.[i] || '').trim(),
  }));
}
async function continueQuestions(run, preference) {
  if (run.status !== 'questions' || planners.has(run.id)) return;
  const answers = pendingQuestionAnswers(run);
  if (preference === 'ask' && answers.some((a) => !a.answer))
    throw new Error('请补充每个问题，或选择「按已有信息整理方案」跳过未答项。');
  run.answers.push(...answers.filter((a) => a.answer));
  run.rounds = (run.rounds || 0) + 1;
  run.clarificationPreference = preference;
  // Continuing the discussion is not authorization to send image requests.
  run.requireManualReview = true;
  run.pendingAnswers = [];
  $('agentPlanDlg').close();
  await planRun(run);
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
  let count = Number($('agentPlanCount').value);
  syncVariantFields(run, count);
  const rows = Array.from($('agentPlanVariants').children);
  let variants;
  if (run.plan.variationSuggestions?.length) {
    const drafts = rows.map((row) => {
      const draft = { label: row.querySelector('input[type=text]').value, prompt: row.querySelector('textarea').value };
      row.querySelector('.agent-variant-description').textContent = draft.prompt;
      row.querySelector('.agent-variant-choice span').textContent = draft.label;
      return draft;
    });
    run.variantDrafts ||= {};
    run.variantDrafts[run.variationGroup] = drafts;
    run.variationSelection = rows.flatMap((row, i) => row.querySelector('input[type=checkbox]').checked ? [i] : []);
    variants = run.variationSelection.map((i) => drafts[i]);
    count = variants.length;
    $('agentPlanCount').value = count;
  } else variants = count > 1 ? rows.map((row) => ({ label: row.querySelector('input').value, prompt: row.querySelector('textarea').value })) : [];
  return {
    ...run.plan,
    model: $('agentPlanModel').value,
    size: $('agentPlanSize').value,
    quality: $('agentPlanQuality').value,
    count,
    variantAxis: variants.length ? $('agentPlanVariantAxis').value : '',
    variants,
    variantPromptMode: variants.length ? 'brief' : 'delta',
    prompt: $('agentPlanPrompt').value,
    constraints: $('agentPlanConstraints').value,
    operation: $('agentPlanOperation').value,
    baseId: $('agentPlanBase').value,
    exactText: $('agentPlanExactText').value,
    format: $('agentPlanFormat').value,
    background: $('agentPlanBackground').value,
    referenceRoles: Array.from($('agentPlanReferences').querySelectorAll('[data-plan-ref]'), (row) => ({
      id: row.dataset.planRef, role: row.querySelector('select').value, note: row.querySelector('input').value,
    })),
  };
}
function compilationSignature(run, plan) {
  return JSON.stringify(variantBrief(plan, run.variantStyleNotes || ''));
}
function compilationCurrent(run, plan) {
  return !!plan.variants.length && run.variantCompilation?.signature === compilationSignature(run, plan);
}
function executablePlan(run, plan) {
  if (!plan.variants.length) return plan;
  if (plan.variantPromptMode === 'complete' && run.approval?.signature === planSignature(plan)) return plan;
  if (!compilationCurrent(run, plan)) throw new Error('请先让 AI 编写当前选择的每张完整提示词，核对后再生成。');
  return { ...plan, variants: run.variantCompilation.variants, variantPromptMode: 'complete' };
}
function renderCompiledVariants(run, plan) {
  const section = $('agentCompiledSection'), list = $('agentCompiledVariants');
  const compilation = run.variantCompilation;
  section.hidden = !compilation;
  if (!compilation) { list.replaceChildren(); delete list.dataset.compilation; return; }
  const current = compilationCurrent(run, plan);
  $('agentCompiledStatus').textContent = current
    ? 'AI 已按你的选择编写。每张独立发送，下方可编辑；尚未发起生图。'
    : '方向、简报或参数已改变，请重新编写提示词后再生成。';
  const key = `${run.id}:${compilation.at}`;
  if (list.dataset.compilation !== key) {
    list.dataset.compilation = key;
    list.innerHTML = compilation.variants.map((v, i) => `<label class="agent-variant">${escapeHTML(v.label)}<textarea class="agent-complete-prompt" data-compiled-prompt="${i}" aria-label="${escapeHTML(v.label)}完整提示词" rows="5" maxlength="4000">${escapeHTML(v.prompt)}</textarea></label>`).join('');
  }
  list.querySelectorAll('textarea').forEach((input) => { input.disabled = !current; });
}
async function compileVariantPrompts(run, plan) {
  if (planners.has(run.id)) return;
  const normalized = normalizePlan(plan, run.context);
  if (!normalized.variants.length) throw new Error('请先选择至少一个变化细节。');
  const controller = new AbortController(), signature = compilationSignature(run, plan);
  const brief = variantBrief(normalized, run.variantStyleNotes || '');
  const imageBase = state.base, imageKey = state.key;
  // Only use the brief to calculate program-added overhead; it is never an executable spec.
  const sharedTask = {
    prompt: '', variant: '', variantPromptMode: 'complete', constraints: normalized.constraints,
    exactText: normalized.exactText, mask: run.snapshot.mask,
    refs: run.snapshot.refs.map((ref) => ({ ...ref, ...normalized.referenceRoles.find((role) => role.id === ref.id) })),
  };
  const overhead = effectivePrompt({ ...sharedTask, prompt: '', variant: '', variantPromptMode: 'complete' }).length;
  const maxPrompt = Math.min(4000, run.context.availableModels.find((model) => model.id === plan.model).maxPrompt - overhead - 4);
  if (maxPrompt < 1) throw new Error('保留要求和参考说明已占满提示词限制，请缩短后再编写。');
  const context = {
    request: run.request, answers: run.answers, brief,
    references: run.context.references,
    maxPrompt,
  };
  const credentials = agentCredentials();
  planners.set(run.id, controller);
  run.variantWriting = true;
  delete run.variantCompilation;
  $('agentPlanFields').inert = true;
  $('agentExecute').textContent = 'AI 正在编写独立提示词…';
  render();
  const timer = setTimeout(() => controller.abort(), 115000);
  try {
    if (!(await persist())) throw new Error('编写状态未能保存，请检查浏览器存储后重试。');
    const previews = await referencePreviews(run.snapshot.refs, controller.signal);
    const data = await agentQuery('variants', { context, previews }, controller.signal, {
      ...credentials, useImageKey: false, apiKey: credentials.key,
    });
    controller.signal.throwIfAborted();
    if (run.stopped) return;
    run.planningUsage.push({ phase: 'variants', at: Date.now(), usage: data.usage });
    if (state.base !== imageBase || state.key !== imageKey) throw new Error('生图连接已变化，请重新编写并确认。');
    if (signature !== compilationSignature(run, run.plan)) throw new Error('变体方向已变化，请按当前选择重新编写。');
    const variants = normalizeCompiledVariants(data.plan, context);
    const complete = { ...normalized, variants, variantPromptMode: 'complete' };
    planTask(run, complete);
    run.variantCompilation = { signature, variants, brief, at: Date.now(), model: credentials.model };
    run.planRevision++;
    delete run.acknowledgedSignature;
    $('agentPlanAcknowledge').checked = false;
    run.error = '';
    if (editingRunId === run.id && $('agentPlanDlg').open) {
      renderCompiledVariants(run, plan);
      $('agentCompiledSection').scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  } catch (error) {
    run.error = controller.signal.aborted ? '提示词编写已停止，可能产生文本用量；没有发起生图，可手动重新编写。' : `提示词编写未通过：${error.message} 尚未发起生图；文本请求可能已计费，不会自动重试。`;
    throw new Error(run.error);
  } finally {
    clearTimeout(timer);
    planners.delete(run.id);
    delete run.variantWriting;
    if (editingRunId === run.id) { $('agentPlanFields').inert = false; updatePlanEstimate(); }
    render(); await persist();
  }
}
function syncVariantFields(run, count, reset = false) {
  const panel = $('agentPlanVariation');
  const list = $('agentPlanVariants');
  const groups = run.plan.variationSuggestions || [];
  $('agentPlanCount').readOnly = !!groups.length;
  $('agentPlanVariantAxis').readOnly = !!groups.length;
  $('agentPlanSuggestions').hidden = !groups.length;
  if (groups.length) {
    panel.hidden = false;
    run.variationGroup ??= Math.max(0, groups.findIndex((group) => group.axis === run.plan.variantAxis));
    const group = groups[run.variationGroup];
    $('agentPlanVariantAxis').value = group.axis;
    if (!reset && list.dataset.group === `${run.id}:${run.variationGroup}`) return;
    list.dataset.group = `${run.id}:${run.variationGroup}`;
    $('agentPlanSuggestionType').textContent = `AI 判断：${run.plan.contentType || '当前图片创作'}。选择一个变化维度，再勾选要生成的细节；最多 ${run.maxRequests} 张。`;
    $('agentPlanSuggestionGroups').innerHTML = groups.map((item, i) => `<button type="button" class="btn ${i === run.variationGroup ? 'outlined' : ''}" aria-pressed="${i === run.variationGroup}" data-variation-group="${i}">${escapeHTML(item.axis)}</button>`).join('');
    $('agentPlanSuggestionReason').textContent = group.reason;
    const drafts = run.variantDrafts?.[run.variationGroup] || group.variants;
    list.innerHTML = drafts.map((variant, i) => `<div class="agent-variant"><label class="agent-variant-choice"><input type="checkbox" aria-label="选用${escapeHTML(variant.label)}" ${run.variationSelection?.includes(i) ? 'checked' : ''}><span>${escapeHTML(variant.label)}</span></label><p class="agent-variant-description">${escapeHTML(variant.prompt)}</p><details><summary>调整细节</summary><label>名称<input type="text" aria-label="建议 ${i + 1} 名称" value="${escapeHTML(variant.label)}" maxlength="100"></label><label>变化细节<textarea aria-label="建议 ${i + 1} 变化细节" rows="2" maxlength="4000">${escapeHTML(variant.prompt)}</textarea></label></details></div>`).join('');
    return;
  }
  delete list.dataset.group;
  panel.hidden = !(count > 1);
  const length = Number.isInteger(count) && count > 1 ? Math.min(3, count) : 0;
  if (!reset && list.children.length === length) return;
  const previous = reset ? run.plan.variants || [] : Array.from(list.children, (row) => ({ label: row.querySelector('input').value, prompt: row.querySelector('textarea').value }));
  list.innerHTML = Array.from({ length }, (_, i) => {
    const variant = previous[i] || { label: '', prompt: '' };
    return `<div class="agent-variant"><label>图片 ${i + 1} · 名称<input type="text" aria-label="图片 ${i + 1} 变体名称" value="${escapeHTML(variant.label)}" maxlength="100" placeholder="如：柔和侧光"></label><label>本张变化<textarea aria-label="图片 ${i + 1} 本张变化" rows="2" maxlength="4000" placeholder="只写这一张在变化维度上的差异">${escapeHTML(variant.prompt)}</textarea></label></div>`;
  }).join('');
}

async function requestPreview(run, plan) {
  const container = $('agentPlanRequestPreview');
  let signature;
  try {
    if (plan.variationSuggestions?.length && !plan.count) throw new Error('请先勾选至少一个变化细节。');
    plan = executablePlan(run, plan);
    const task = planTask(run, plan);
    const route = plan.operation === 'crop' ? '本地处理' : task.refs.length ? 'POST /images/edits' : 'POST /images/generations';
    const specs = agentImageSpecs(plan);
    const expanded = $('agentPlanExecutionPreview').open;
    signature = JSON.stringify([run.id, planSignature(plan), task.refs.map((ref) => ref.id), run.planRevision, expanded]);
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    const overview = `<p>${plan.operation === 'crop' ? '不发送生图请求。' : `程序将拆为 ${specs.length} 个请求，每个请求 n=1。首次生成共 ${specs.length} 张；重试与回退共用 ${run.maxRequests} 次请求上限。`}<br>${escapeHTML(route)} · ${escapeHTML(plan.model)} · ${escapeHTML(plan.size)} · ${escapeHTML(plan.format)}</p>${plan.variantPromptMode === 'complete' ? `<p>提示词来源：${escapeHTML(run.variantCompilation.model)} 逐张编写，经你确认后发送；共同简报和原始批次需求不会前置。</p>` : ''}<p>参考顺序：${escapeHTML(task.refs.map((ref, i) => `图 ${i + 1}：${ref.name}（${ROLE_NAMES[ref.role]}，${ref.id}）`).join('；') || '无参考图')}。</p>`;
    container.innerHTML = overview;
    if (!expanded || plan.operation === 'crop') return;
    const prepared = await Promise.all(specs.map((spec) => prepareGptRequest({ ...task, ...spec, effectivePrompt: effectivePrompt({ ...task, ...spec }) })));
    if (container.dataset.signature !== signature) return;
    container.innerHTML = overview + prepared.map((request, i) => `<details><summary>图片 ${i + 1}${specs[i].variantLabel ? ' · ' + escapeHTML(specs[i].variantLabel) : ''} · 完整发送提示词</summary><p>POST ${escapeHTML(request.path)} · n=${request.params.n}</p><p class="agent-request-prompt">${escapeHTML(request.params.prompt)}</p></details>`).join('') + (task.mask ? '<p>以上已包含程序追加的选区或扩图说明。蒙版按当前线路使用原生蒙版或引导图；结果保护策略见作品详情。</p>' : '');
  } catch (error) {
    if (signature && container.dataset.signature !== signature) return;
    delete container.dataset.signature;
    container.textContent = '暂不能执行：' + error.message;
  }
}
function updatePlanEstimate() {
  const run = runById(editingRunId);
  if (!run || run.status !== 'review') return;
  const plan = formPlan(run),
    price = planPrice(run, plan);
  $('agentPlanEstimate').textContent =
    plan.operation === 'crop' ? '本地裁切 · 0 次生图请求 · 不产生生图费用。确认范围后保存为新版本。' : `${plan.count} 张 · ${price === null ? '未填写单价，无法估价' : '首次生成估算 ' + money(price * plan.count, run.currency)} · 最多 ${run.maxRequests} 次请求${run.costLimit === null ? '；不自动重试' : '，估算上限 ' + money(run.costLimit, run.currency)}。规划文本费用另计。`;
  const compiled = compilationCurrent(run, plan);
  const candidates = plan.operation === 'crop' ? [] : compatibleCandidates(run, compiled ? executablePlan(run, plan) : plan);
  $('agentPlanFallbacks').textContent = plan.variants.length && !compiled ? '完整提示词编写后，再核对兼容的备用模型 / 线路。' : candidates.length
    ? '允许的兼容备用：' + candidates.map(gptModelLabel).join('、')
    : '本次没有兼容且已授权的备用模型 / 线路。';
  const issues = executionIssues(plan, run.snapshot);
  renderCompiledVariants(run, plan);
  requestPreview(run, plan);
  $('agentPlanIssues').textContent = issues.join(' ');
  $('agentPrepareOperation').hidden = !['local', 'crop', 'outpaint'].includes(plan.operation);
  $('agentPrepareOperation').textContent = { local: '划选 / 核对修改区域', crop: '预览裁切范围', outpaint: '设置扩图方向和保留策略' }[plan.operation] || '设置操作范围';
  const base = run.snapshot.refs.find((ref) => ref.id === plan.baseId);
  const preview = $('agentPlanBasePreview');
  if (preview.dataset.baseId !== (base?.id || '')) {
    preview.dataset.baseId = base?.id || '';
    preview.innerHTML = base ? `<img src="${escapeHTML(referenceURL(base))}" alt="本轮指定底图"><div><strong>${escapeHTML(base.name)}</strong><p>版本：${escapeHTML(base.versionId || run.snapshot.parentId || '导入素材')}<br>原图保留，结果创建新版本。</p></div>` : '<p>新建作品 · 参考图按各自用途参与创作。</p>';
  }
  const reviewedPlan = compilationCurrent(run, plan) ? executablePlan(run, plan) : plan;
  const conflicts = [...(run.planConflicts || []), ...requirementConflicts(reviewedPlan, run.requirements)];
  const unique = [...new Map(conflicts.map((item) => [item.field + JSON.stringify(item.actual), item])).values()];
  $('agentPlanDifferences').innerHTML = [
    run.requirements?.legacy ? '<p>旧作品缺少已确认要求记录，请核对保留项和必要参考。</p>' : '',
    run.requirements?.requiresReview ? '<p>本轮可能改变上一版的文案、Logo 或保留项，请核对需要覆盖的要求。</p>' : '',
    ...unique.map((item) => `<p><strong>${escapeHTML(item.label)}</strong> · 原要求：${escapeHTML(String(item.expected))}<br>方案建议：${escapeHTML(String(item.actual ?? '未指定'))}</p>`),
  ].join('');
  $('agentPlanAcknowledgeLabel').hidden = !unique.length && !run.requirements?.legacy && !run.requirements?.requiresReview;
  $('agentExecute').textContent = plan.operation === 'crop' ? '预览并确认裁切' : `确认${OPERATIONS[plan.operation] || '生成'} · ${base ? base.name.slice(0, 14) : '新作品'}`;
  if (run.plan.variationSuggestions?.length) {
    $('agentPlanSelectedCount').textContent = `已选 ${plan.count} 张；只为勾选的变化创建任务。`;
    $('agentExecute').disabled = plan.count === 0;
    if (!plan.count) $('agentExecute').textContent = '请先选择变化细节';
  }
  if (plan.variants.length) {
    $('agentExecute').textContent = compilationCurrent(run, plan) ? `确认生成 ${plan.count} 张独立图片` : `让 AI 编写 ${plan.count} 张提示词`;
    $('agentExecute').disabled = !!run.variantWriting;
  }
  if (run.variantWriting) { $('agentExecute').disabled = true; $('agentExecute').textContent = 'AI 正在编写独立提示词…'; }
  $('agentPlanRoute').textContent = `实际入口：${plan.operation === 'crop' ? '浏览器本地' : run.snapshot.refs.length ? '/images/edits' : '/images/generations'}。${plan.operation === 'create' && run.snapshot.refs.length ? '图片仅作参考，不绑定编辑底图。' : ''}镜头、灯光和构图来自 Agent 建议。字形、Logo、选区与主体结构仍需人工核对。`;
}
function openPlan(run) {
  if (!['questions', 'review'].includes(run.status)) return;
  editingRunId = run.id;
  const questioning = run.status === 'questions';
  $('agentPlanTitle').textContent = questioning ? '补充几个关键点' : '确认创作方案';
  $('agentPlanSummary').textContent = run.plan.summary;
  $('agentPlanError').textContent = run.error || '';
  $('agentPlanAcknowledge').checked = false;
  $('agentPlanBasePreview').dataset.baseId = 'refresh';
  $('agentPlanFields').hidden = questioning;
  $('agentPlanFields').inert = !!run.variantWriting;
  $('agentQuestions').hidden = !questioning;
  $('agentQuestions').innerHTML = questioning ? questionFields(run) : '';
  $('agentImportPlan').hidden = false;
  $('agentDraftPlan').hidden = !questioning;
  $('agentQuestionHelp').hidden = !questioning;
  $('agentQuestionHelp').textContent = questioning ? `当前是第 ${(run.rounds || 0) + 1} 轮补问，无固定轮数上限。你可以继续回答，也可跳过未答项先整理方案；底图、保留项和操作范围有冲突时仍需确认。继续规划只产生文本用量，生图前可查看方案。` : '';
  $('agentPlanKnownRequirements').hidden = !questioning && !run.requireManualReview;
  $('agentPlanKnownRequirements').textContent = questioning ? `当前已记录：${run.requirements?.values.constraints || '保留项待补充'}。${run.snapshot.refs.length} 张参考 · ${run.snapshot.settings.size}。可在回答中说明新的范围或规格，或转到输入框调整。` : run.requireManualReview ? `已保留需求和 ${run.answers.length} 条回答。本轮方案需你确认后才会生图。` : '';
  $('agentExecute').textContent = questioning ? '补充并继续规划' : '确认并生成';
  $('agentExecute').disabled = false;
  if (!questioning) {
    const plan = run.plan;
    $('agentPlanPrompt').value = plan.prompt;
    $('agentPlanStyleNotes').value = run.variantStyleNotes || '';
    $('agentPlanVariantAxis').value = plan.variantAxis || '';
    syncVariantFields(run, plan.count, true);
    $('agentPlanConstraints').value = plan.constraints;
    $('agentPlanOperation').value = plan.operation;
    $('agentPlanExactText').value = plan.exactText || '';
    $('agentPlanFormat').value = plan.format;
    $('agentPlanBackground').value = plan.background;
    $('agentPlanBase').innerHTML = '<option value="">不选择底图（新建）</option>' + run.snapshot.refs.map((ref, i) => `<option value="${escapeHTML(ref.id)}">图 ${i + 1} · ${escapeHTML(ref.name)}</option>`).join('');
    $('agentPlanBase').value = plan.baseId;
    $('agentPlanModel').innerHTML = run.context.availableModels
      .map((m) => `<option value="${m.id}">${escapeHTML(gptModelLabel(m.id))}</option>`)
      .join('');
    $('agentPlanModel').value = plan.model;
    $('agentPlanCount').value = plan.count;
    $('agentPlanCount').max = run.maxRequests;
    fillPlanOptions(plan, run);
    $('agentPlanReferences').innerHTML = plan.referenceRoles.map((role, i) => {
      const ref = run.snapshot.refs.find((ref) => ref.id === role.id);
      return `<div class="agent-plan-reference" data-plan-ref="${escapeHTML(role.id)}"><img src="${escapeHTML(referenceURL(ref))}" alt="参考图 ${i + 1}"><div><label>图 ${i + 1} 用途<select aria-label="图 ${i + 1} 用途">${Object.entries(ROLE_NAMES).map(([key, value]) => `<option value="${key}" ${key === role.role ? 'selected' : ''}>${value}</option>`).join('')}</select></label><input value="${escapeHTML(role.note)}" maxlength="300" aria-label="图 ${i + 1} 参考说明" placeholder="只参考什么 / 保留什么"><button type="button" class="btn" data-detail-reference="${escapeHTML(role.id)}">选取高清细节并重新规划</button></div></div>`;
    }).join('');
    updatePlanEstimate();
  }
  showDialog('agentPlanDlg');
  $('agentPlanDlg').querySelector('.preset-dialog-body').scrollTop = 0;
}

async function prepareOperation(run, plan, commitCrop = false) {
  const base = run.snapshot.refs.find((ref) => ref.id === plan.baseId);
  if (!base) throw new Error('请先选择底图。');
  if (plan.size === 'auto') throw new Error('请先选择明确的交付尺寸。');
  const mode = { local: 'mask', crop: 'crop', outpaint: 'expand' }[plan.operation];
  if (!mode) return;
  const originalSignature = planSignature(plan);
  $('agentPlanDlg').close();
  await openEditor(mode, {
    ref: base, mask: run.snapshot.mask, size: plan.size, format: plan.format,
    onComplete: () => { if (run.status === 'review') openPlan(run); },
    onApply: async (result) => {
      if (run.stopped || run.status !== 'review' || originalSignature !== planSignature(run.plan)) throw new Error('方案已变化或停止，请重新确认。');
      if (plan.operation === 'crop') {
        if (!commitCrop) throw new Error('请从确认裁切按钮进入，以保存裁切版本。');
        if (run.submissionId) return;
        const issues = executionIssues(plan, run.snapshot);
        if (issues.length) throw new Error(issues.join(' '));
        const outputCheck = await inspectOutput(result.ref.blob, plan);
        const id = uid(), parentId = base.versionId || run.snapshot.parentId || null;
        const task = {
          id, parentId, rootId: taskById(parentId)?.rootId || parentId || id,
          projectId: run.snapshot.projectId, prompt: plan.prompt, constraints: plan.constraints,
          exactText: plan.exactText, operation: 'crop', refs: run.snapshot.refs,
          settings: { ...run.snapshot.settings, size: plan.size, format: plan.format }, mask: null,
          status: 'success', createdAt: Date.now(), finishedAt: Date.now(), outputBlob: result.ref.blob,
          crop: result.crop, outputCheck, postprocessOnly: true, agentRunId: run.id,
          confirmedRequirements: confirmedRequirements(run, plan),
          approval: { signature: originalSignature, plan: structuredClone(plan), at: Date.now() },
          attempts: 0, batchId: run.id, priceEstimate: 0, currency: run.currency,
        };
        run.submissionId = uid(); run.status = 'success'; run.resultIds = [id]; run.taskIds = [id];
        run.finishedAt = Date.now(); run.localOperation = result.crop;
        state.tasks.unshift(task);
        if (!(await persist())) {
          state.tasks = state.tasks.filter((item) => item.id !== id);
          run.status = 'review'; delete run.submissionId;
          throw new Error('裁切版本未能保存，请检查浏览器存储后重试。');
        }
        render();
        setStatus('已保存本地裁切新版本，没有新增生图请求。');
        return;
      }
      if (!result.mask) throw new Error(plan.operation === 'local' ? '请划选修改区域。' : '请开启 AI 补全并保留需要扩展的新区域。');
      run.snapshot.refs = run.snapshot.refs.map((ref) => ref.id === base.id ? result.ref : ref);
      run.snapshot.refs.sort((a, b) => Number(b.id === result.ref.id) - Number(a.id === result.ref.id));
      run.snapshot.mask = result.mask;
      run.snapshot.settings.size = `${result.mask.width}x${result.mask.height}`;
      run.snapshot.settings.format = 'png';
      run.plan = { ...plan, baseId: result.ref.id, size: run.snapshot.settings.size, format: 'png', referenceRoles: plan.referenceRoles.map((ref) => ref.id === base.id ? { ...ref, id: result.ref.id, role: 'base' } : ref) };
      run.context.hasMask = true;
      run.context.currentSettings = run.snapshot.settings;
      run.context.references = run.snapshot.refs.map(({ id, role, note }) => ({ id, role, note }));
      run.requirements.values.baseId = result.ref.id;
      run.requirements.references = run.requirements.references.map((ref) => ref.id === base.id ? { ...ref, id: result.ref.id, role: 'base' } : ref);
      run.planRevision++; delete run.acknowledgedSignature;
      await persist();
    },
  });
}
function renderAgentActivity() {
  const panel = $('agentActivity'),
    trigger = $('agentActivityBtn'),
    run = runById(activityRunId),
    next = latestActivity();
  if (!isLive(run)) {
    activityRunId = null;
    activityOpen = false;
    if (['failed', 'unknown'].includes(run?.status))
      notify(`Agent ${AGENT_STATUSES[run.status]}，可从右上角查看记录。`);
  }
  if (!activityOpen && panel.contains(document.activeElement)) trigger.focus({ preventScroll: true });
  panel.inert = !activityOpen;
  panel.classList.toggle('is-open', activityOpen);
  trigger.setAttribute('aria-expanded', String(activityOpen));
  const label = activityOpen
    ? '收起 Agent 浮窗'
    : next
      ? `打开 Agent 浮窗 · ${AGENT_STATUSES[(isLive(run) ? run : next).status]}`
      : 'Agent 记录';
  trigger.setAttribute('aria-label', label);
  trigger.dataset.tooltip = label;
  const dot = $('agentActivityDot');
  dot.hidden = !next;
  dot.classList.toggle('needs-input', state.agentRuns.some((r) => isLive(r) && needsInput(r)));
  if (!activityOpen) return;

  panel.dataset.agentRun = run.id;
  $('agentActivitySpinner').hidden = !inProgress(run) && !run.variantWriting;
  const review = $('agentActivityReview');
  if (!needsInput(run) && document.activeElement === review)
    $('agentActivityMinimize').focus({ preventScroll: true });
  review.hidden = !needsInput(run) || !!run.variantWriting;
  review.textContent = run.status === 'questions' ? '补充需求' : '确认方案';
  const description = {
    planning: '正在结合内容和你的回答，讨论创作方向。',
    questions: '由你选择：继续回答、按已有信息整理方案，或转到输入框编辑。',
    review: run.variantWriting ? '正在将所选细节编写成每张完整提示词；尚未生图。' : run.plan?.summary || '方案已准备好，请确认后开始生成。',
    running: `${gptModelLabel(run.plan?.model || run.snapshot.settings.model)} · ${run.requests || 0}/${run.maxRequests} 次生图请求`,
    queued: '方案已确认，等待队列提交。',
    checking: '正在核对文件、尺寸和格式；创作效果待人工核对。',
    submitting: '正在校验素材并保存已确认的执行快照。',
    unknown: '已有请求的结果需要核实；可查看记录和已成功作品，不会自动重发。',
  };
  for (const [id, value] of [
    ['agentActivityStatus', run.variantWriting ? '编写提示词中' : AGENT_STATUSES[run.status]],
    ['agentActivityDescription', run.error || description[run.status]],
    ['agentActivityRequest', run.request],
  ]) {
    if ($(id).textContent !== value) $(id).textContent = value;
  }
  const work = $('agentActivityWork');
  const plan = run.plan;
  const signature = JSON.stringify([run.id, planSignature(plan || {}), run.planRevision]);
  if (work.dataset.signature !== signature) {
    work.dataset.signature = signature;
    const base = run.snapshot.refs.find((ref) => ref.id === plan?.baseId);
    work.innerHTML = `${base ? `<img src="${escapeHTML(referenceURL(base))}" alt="本轮底图">` : ''}<p>${escapeHTML(base ? base.name : '新作品')}<br>${escapeHTML(OPERATIONS[plan?.operation] || '等待规划')} · ${escapeHTML(plan?.size || run.snapshot.settings.size)} · ${plan?.count || 1} 张</p>${plan?.decision === 'ready' ? `<p>改动：${escapeHTML(plan.prompt.slice(0, 150))}</p><p>保留：${escapeHTML(plan.constraints.slice(0, 150) || '请在确认卡中核对')}</p>` : ''}`;
  }
}

export function renderAgentRuns() {
  renderAgentActivity();
  if ($('agentHistoryDlg').open) renderAgentHistory();
}

function renderAgentHistory() {
  const list = $('agentHistoryList');
  const runs = state.agentRuns.filter((run) => !run.dismissed);
  const signature = JSON.stringify(
    runs.map((r) => [
      r.id,
      r.status,
      r.error,
      r.requests,
      r.usedEstimate,
      r.plan?.summary,
      r.planRevision, r.planningUsage?.length, r.variantWriting,
      r.requestLog?.map((item) => item.outcome),
    ]),
  );
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
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
    <div class="agent-run-heading"><strong>${inProgress(run) ? '<span class="spinner"></span>' : icon('mark')} Agent · ${AGENT_STATUSES[run.status] || '已停止'}</strong><div>${isLive(run) && run.status !== 'unknown' ? '<button class="btn" data-agent-action="stop">停止</button>' : ''}<button class="icon-btn" data-agent-action="dismiss" aria-label="隐藏方案记录">${icon('close')}</button></div></div>
    <p class="agent-run-request">${escapeHTML(run.request)}</p>
    ${['failed', 'unknown'].includes(run.status) ? '<p class="agent-run-summary">' + escapeHTML(run.error || '查看图片卡片与执行记录。') + '</p>' : ''}
    <div class="agent-run-footer"><span>${run.requests || 0}/${run.maxRequests} 次生图请求${run.usedEstimate ? ' · 已预留估算 ' + money(run.usedEstimate, run.currency) : ''}</span><div>
    ${['questions', 'review'].includes(run.status) ? '<button class="btn primary" data-agent-action="review">' + (run.status === 'questions' ? '补充需求' : '查看并确认方案') + '</button>' : ''}
    ${inProgress(run) || run.status === 'unknown' ? '<button class="btn" data-agent-action="open">打开此会话</button>' : ''}
    ${run.status !== 'planning' ? '<button class="btn" data-agent-action="import">导入输入框</button>' : ''}
    ${run.resultIds?.length ? '<button class="btn" data-agent-action="result">查看作品 / 从本版继续</button>' : ''}
    ${run.status === 'failed' ? '<button class="btn" data-agent-action="replan">保留回答重新规划</button>' : ''}</div></div>
    <details class="agent-execution" ${expanded.has(run.id) ? 'open' : ''}><summary>方案与执行记录</summary><p>${escapeHTML(run.request)}</p><p>${escapeHTML(run.error || run.plan?.summary || '')}</p><p>规划模型：${escapeHTML(run.plannerModel || getAgentConnection().model)} · 方向规划 ${(run.planningUsage || []).filter((item) => item.phase !== 'variants').length} 次 · 独立提示词编写 ${(run.planningUsage || []).filter((item) => item.phase === 'variants').length} 次</p>${run.variantStyleNotes ? `<p>变体偏好：${escapeHTML(run.variantStyleNotes)}</p>` : ''}${run.answers.map((item) => `<p>${escapeHTML(item.question)}：${escapeHTML(item.answer)}</p>`).join('')}
    ${run.plan?.decision === 'ready' ? `<p>${escapeHTML(run.plan.model)} · ${escapeHTML(run.plan.size)} · ${escapeHTML(run.plan.quality)} · ${run.plan.count} 张</p><p>${escapeHTML(run.plan.prompt)}</p>${run.plan.variants?.length ? `<p>变化维度：${escapeHTML(run.plan.variantAxis)}</p>` + run.plan.variants.map((v) => `<p>${escapeHTML(v.label)}：${escapeHTML(v.prompt)}</p>`).join('') : ''}` : ''}
    <ol>${(run.requestLog || []).map((item) => `<li>${item.variantLabel ? escapeHTML(item.variantLabel) + ' · ' : ''}${escapeHTML(item.model)} · ${escapeHTML({ success: '成功', failed: '失败', unknown: '结果待核实', limited: '限流', unavailable: '不可用，切换候选' }[item.outcome] || '已提交')} · ${item.estimate == null ? '无价格估算' : '预留估算 ' + money(item.estimate, run.currency)}${item.request ? `<details><summary>实际请求 · ${escapeHTML(item.request.path)} · n=${item.request.n}</summary><p>任务：${escapeHTML(item.taskId)} · 方案版本 ${item.planRevision || 1} · 参考 ID：${escapeHTML(item.request.refIds.join('、') || '无')}</p><p class="agent-request-prompt">${escapeHTML(item.prompt || '')}</p></details>` : ''}</li>`).join('')}</ol></details></article>`,
    )
    .join('') || '<p class="agent-history-empty">使用 Agent 提交需求后，方案和执行记录会显示在这里。</p>';
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
}
function openAgentHistory() {
  renderAgentHistory();
  showDialog('agentHistoryDlg');
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
  if (!['running', 'checking', 'queued'].includes(run.status)) run.status = 'cancelled';
  run.error = '后续步骤已停止；已经提交的请求可能仍在服务端处理。';
  if (editingRunId === run.id && $('agentPlanDlg').open) $('agentPlanDlg').close();
  render();
  await persist();
}
export function mountAgent() {
  const minimize = () => {
    activityOpen = false;
    renderAgentActivity();
  };
  $('agentActivityBtn').onclick = (e) => {
    if (activityOpen) return minimize();
    const selected = runById(activityRunId);
    const run = isLive(selected) ? selected : latestActivity();
    if (!run) return openAgentHistory();
    activityRunId = run.id;
    activityOpen = true;
    renderAgentActivity();
    if (e.detail === 0) $('agentActivityMinimize').focus({ preventScroll: true });
  };
  $('agentActivityMinimize').onclick = minimize;
  $('agentActivityHistory').onclick = openAgentHistory;
  $('agentActivity').onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      minimize();
    }
  };
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
          clarificationPreference: 'draft',
          clarificationRounds: 0,
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
    if (action === 'open') { $('agentHistoryDlg').close(); activityRunId = run.id; activityOpen = true; renderAgentActivity(); }
    if (action === 'review') {
      $('agentHistoryDlg').close();
      openPlan(run);
    }
    if (action === 'stop') await stopRun(run);
    if (action === 'dismiss') {
      if (inProgress(run) || needsInput(run)) await stopRun(run);
      run.dismissed = true;
      render();
      await persist();
    }
    if (action === 'import') importRun(run);
    if (action === 'result') {
      const task = taskById(run.resultIds[0]);
      if (task) { $('agentHistoryDlg').close(); openDetail(task.id); }
    }
    if (action === 'replan') {
      $('agentHistoryDlg').close();
      const next = {
        id: uid(), schemaVersion: SESSION_VERSION, previousRunId: run.id,
        snapshot: structuredClone(run.snapshot), requirements: structuredClone(run.requirements),
        request: run.request, createdAt: Date.now(), rounds: run.rounds || 0,
        answers: structuredClone([...(run.answers || []), ...pendingQuestionAnswers(run).filter((a) => a.answer)]),
        clarificationPreference: run.clarificationPreference || 'ask', requireManualReview: true,
        variationFeedback: run.variationFeedback || '',
        detailReferences: structuredClone(run.detailReferences || []),
        maxRequests: run.maxRequests, costLimit: run.costLimit, currency: run.currency,
        allowedCandidates: [...(run.allowedCandidates || [])], requests: 0, usedEstimate: 0, requestLog: [],
      };
      state.agentRuns.unshift(next);
      activityRunId = next.id;
      activityOpen = true;
      await planRun(next);
    }
  });
  $('agentActivity').onclick = activityAction;
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
    persist();
  };
  $('agentPlanModel').onchange = () => {
    const run = runById(editingRunId);
    if (!run) return;
    fillPlanOptions(formPlan(run), run);
    updatePlanEstimate();
  };
  $('agentPlanForm').addEventListener('input', (event) => {
    const run = runById(editingRunId);
    if (run?.status === 'review') {
      run.variantStyleNotes = $('agentPlanStyleNotes').value;
      const compiledInput = event.target.closest('[data-compiled-prompt]');
      if (compiledInput && run.variantCompilation) {
        run.variantCompilation.variants[Number(compiledInput.dataset.compiledPrompt)].prompt = compiledInput.value;
        run.planRevision++; $('agentPlanAcknowledge').checked = false; delete run.acknowledgedSignature;
      }
      const plan = formPlan(run);
      if (planSignature(plan) !== planSignature(run.plan)) { run.planRevision++; $('agentPlanAcknowledge').checked = false; delete run.acknowledgedSignature; }
      run.plan = plan;
      updatePlanEstimate();
      persist();
    }
  });
  $('agentPlanForm').addEventListener('change', () => {
    const run = runById(editingRunId);
    if (run?.status === 'review') {
      const plan = formPlan(run);
      if (planSignature(plan) !== planSignature(run.plan)) { run.planRevision++; $('agentPlanAcknowledge').checked = false; delete run.acknowledgedSignature; }
      run.plan = plan;
      updatePlanEstimate();
      persist();
    }
  });
  $('agentPlanDlg').addEventListener('close', () => {
    persist();
  });
  $('agentPlanExecutionPreview').addEventListener('toggle', () => {
    if ($('agentPlanDlg').open) updatePlanEstimate();
  });
  $('agentPlanSuggestionGroups').onclick = (event) => {
    const button = event.target.closest('[data-variation-group]');
    const run = runById(editingRunId);
    if (!button || !run) return;
    run.variationGroup = Number(button.dataset.variationGroup);
    run.variationSelection = [];
    run.planRevision++;
    delete run.acknowledgedSignature;
    $('agentPlanAcknowledge').checked = false;
    syncVariantFields(run, 0, true);
    run.plan = formPlan(run);
    updatePlanEstimate(); persist();
  };
  $('agentReviseVariants').onclick = guard(async () => {
    const run = runById(editingRunId);
    if (!run || run.status !== 'review' || planners.has(run.id)) return;
    const feedback = $('agentPlanStyleNotes').value.trim();
    if (!feedback) throw new Error('请先写下想调整的风格、变化幅度或要保留的内容。');
    run.variantStyleNotes = feedback;
    run.variationFeedback = feedback;
    $('agentPlanDlg').close();
    activityRunId = run.id; activityOpen = true;
    await planRun(run);
    if (needsInput(run)) openPlan(run);
  });
  $('agentRewriteVariants').onclick = async () => {
    const run = runById(editingRunId);
    if (!run || run.status !== 'review') return;
    $('agentPlanError').textContent = '';
    $('agentExecute').disabled = true;
    try { await compileVariantPrompts(run, formPlan(run)); }
    catch (error) { if (editingRunId === run.id) $('agentPlanError').textContent = error.message; }
    finally { if (editingRunId === run.id && run.status === 'review') updatePlanEstimate(); }
  };
  $('agentPlanReferences').onclick = guard(async (e) => {
    const id = e.target.closest('[data-detail-reference]')?.dataset.detailReference;
    const run = runById(editingRunId);
    if (!id || !run) return;
    if (run.snapshot.refs.length + (run.detailReferences?.length || 0) >= 16) throw new Error('预览总数最多 16 张，请减少参考图后添加高清细节。');
    const ref = run.snapshot.refs.find((ref) => ref.id === id);
    $('agentPlanDlg').close();
    await openEditor('crop', { ref, size: '1024x1024', onApply: async (result) => {
      run.detailReferences ||= [];
      run.detailReferences.push({ ...result.ref, parentId: id, crop: result.crop });
      await persist();
      queueMicrotask(() => planRun(run));
    } });
  });
  $('agentPlanForm').onsubmit = async (e) => {
    e.preventDefault();
    const run = runById(editingRunId);
    if (!run || !['questions', 'review'].includes(run.status)) return;
    $('agentExecute').disabled = true;
    $('agentPlanError').textContent = '';
    try {
      if (run.status === 'questions') {
        await continueQuestions(run, 'ask');
      } else {
        const plan = formPlan(run);
        if (plan.variants.length && !compilationCurrent(run, plan)) {
          await compileVariantPrompts(run, plan);
          return;
        }
        const finalPlan = executablePlan(run, plan);
        if ($('agentPlanAcknowledge').checked) run.acknowledgedSignature = planSignature(finalPlan);
        if (plan.operation === 'crop') {
          validateExecution(run, finalPlan);
          await prepareOperation(run, finalPlan, true);
        } else await execute(run, finalPlan);
      }
    } catch (e) {
      if (editingRunId === run.id) $('agentPlanError').textContent = e.message;
    } finally {
      $('agentExecute').disabled = false;
      if (run.status === 'review') updatePlanEstimate();
    }
  };
  $('agentDraftPlan').onclick = async () => {
    const run = runById(editingRunId);
    if (run?.status !== 'questions') return;
    $('agentDraftPlan').disabled = $('agentExecute').disabled = true;
    $('agentPlanError').textContent = '';
    try { await continueQuestions(run, 'draft'); }
    catch (e) { if (editingRunId === run.id) $('agentPlanError').textContent = e.message; }
    finally { $('agentDraftPlan').disabled = $('agentExecute').disabled = false; }
  };
  $('agentImportPlan').onclick = () => {
    const run = runById(editingRunId);
    if (run) importRun(run);
  };
  $('agentPrepareOperation').onclick = guard(async () => {
    const run = runById(editingRunId);
    if (!run) return;
    if (run.plan.operation === 'crop') {
      if ($('agentPlanAcknowledge').checked) run.acknowledgedSignature = planSignature(run.plan);
      validateExecution(run, run.plan);
    }
    await prepareOperation(run, run.plan, run.plan.operation === 'crop');
  });
}

export async function continueWithAgent(task) {
  const pending = state.agentRuns.find((run) => run.snapshot?.parentId === task.id && needsInput(run));
  if (pending) {
    activityRunId = pending.id; activityOpen = true;
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    renderAgentActivity(); openPlan(pending); return;
  }
  await continueTask(task);
  setComposerMode(true);
  setStatus('已绑定所选版本与该分支保留要求，填写本轮修改后提交 Agent。');
}
function importRun(run) {
  $('agentHistoryDlg').close();
  $('agentPlanDlg').close();
  activityOpen = false;
  renderAgentActivity();
  const draft = structuredClone(run.snapshot);
  draft.variantAxis = '';
  draft.variants = '';
  draft.variantPromptMode = 'delta';
  const answers = [...(run.answers || []), ...pendingQuestionAnswers(run).filter((a) => a.answer)];
  const discussion = answers.map((a) => `${a.question}\n${a.answer}`).join('\n\n');
  draft.prompt = [run.request || draft.prompt, discussion && `已补充的需求：\n${discussion}`, run.variationFeedback].filter(Boolean).join('\n\n');
  if (run.plan?.decision === 'ready') {
    let plan;
    try { plan = normalizePlan(executablePlan(run, run.plan), run.context); }
    catch { notify('旧方案未拆分为逐张内容，已恢复原始需求；请重新规划。'); restoreDraft(draft); setComposerMode(true); focusComposer(); return; }
    draft.prompt = plan.prompt;
    draft.exactText = plan.exactText;
    draft.constraints = plan.constraints;
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
    draft.n = 1;
    if (plan.variants?.length) {
      draft.variantAxis = Array.from($('variantAxis').options).some((option) => option.value === plan.variantAxis) ? plan.variantAxis : '自定义方案';
      draft.variants = plan.variants.map((variant) => variant.prompt.replace(/\s*\n\s*/g, ' ')).join('\n');
      draft.variantPromptMode = 'complete';
    }
  }
  draft.editQueuedId = null;
  restoreDraft(draft);
  setComposerMode(false);
  scheduleDraft();
  focusComposer();
  updateSend();
  setStatus('已导入方案和原始参考素材，可手动编辑后生成。');
}
