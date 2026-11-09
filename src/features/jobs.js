import { $, numeric } from '../core/dom.js';
import { active, controllers, existing, state, taskById } from '../core/state.js';
import { ROLE_NAMES } from '../core/config.js';
import { showSettings } from '../services/connection.js';
import { askConfirm, guard, notify, setStatus } from '../ui/dialogs.js';
import {
  captureDraft,
  collapseAdvanced,
  expandComposer,
  renderEditContext,
  settingsSnapshot,
  updateSend,
  variantsList,
} from './composer.js';
import { copyRefs, fetchImage, validSrc } from '../core/assets.js';
import { validateGptTask } from '../services/models.js';
import {
  encodeGptOutput,
  gptFormatCorrection,
  prepareGptRequest,
  validateGptMask,
} from '../services/images.js';
import { uid } from '../core/utils.js';
import { runtime } from '../core/runtime.js';
import { priceFor } from '../services/pricing.js';
import { duration, render } from './gallery.js';
import { persist } from '../core/storage.js';
import { isOutpaintTask } from './outpaint.js';
import { inspectOutput } from '../core/output-check.js';
import { decodeImageBlob } from '../core/image-input.js';
import { executionIssues, planSignature } from '../../shared/agent-requirements.js';
import { agentImageSpecs, imagePromptLines } from '../../shared/agent-variants.js';
import { renderAgentRuns, startAgentPlan } from './agent.js';
import {
  agentCanRetry,
  agentRunFor,
  authorizeAgentRun,
  nextAgentCandidate,
  recordAgentHealth,
  reserveAgentRequest,
  syncAgentRuns,
} from '../core/agent-budget.js';
function currentLimit() {
  const limit = numeric('concurrency', 1, 8, 3);
  state.prefs.concurrency = limit;
  return limit;
}
function effectivePrompt(t) {
  const lines = imagePromptLines(t);
  if (t.refs.length)
    lines.push(
      '参考图说明（按上传顺序）：',
      ...t.refs.map(
        (r, i) =>
          `图 ${i + 1}：${ROLE_NAMES[r.role] || '一般参考'}${r.note ? '；' + r.note : ''}。`,
      ),
    );
  if (t.constraints) lines.push('必须保持：' + t.constraints);
  if (t.exactText) lines.push('逐字文案（保留大小写、空格、标点与语言；图中文字需人工核对）：\n' + t.exactText);
  if (t.mask)
    lines.push(
      t.mask.kind === 'outpaint'
        ? '扩展画布：只补全已有画面边界之外的区域，保持原图位置和比例。'
        : '仅修改蒙版透明区域，保持其余内容尽量不变。',
    );
  return lines.join('\n\n');
}
async function submit() {
  if (!state.ready || state.adding || state.submitting) return;
  if (state.agentMode) return startAgentPlan();
  if (!state.key) {
    showSettings();
    return;
  }
  const prompt = $('prompt').value.trim();
  if (!prompt) {
    setStatus('请先填写画面描述或修改要求。', true);
    expandComposer();
    $('prompt').focus();
    return;
  }
  const settings = settingsSnapshot(),
    variants = variantsList(),
    n = numeric('n', 1, 4, 1);
  if (!state.editQueuedId && (!variants.length || variants.length > 8)) {
    setStatus('请填写 1–8 行批量方案，或关闭变化维度。', true);
    return;
  }
  if (settings.background === 'transparent' && settings.format === 'jpeg') {
    setStatus('透明背景请使用 PNG 或 WebP。', true);
    return;
  }
  if (state.mask && state.mask.assetId !== state.refs[0]?.id) {
    setStatus('蒙版与第一张参考图不匹配，请重新涂抹。', true);
    return;
  }
  const base = {
    prompt,
    settings,
    refs: copyRefs(state.refs),
    constraints: $('constraints').value.trim(),
    parentId: state.parentId,
    rootId: taskById(state.parentId)?.rootId || state.parentId || null,
    projectId: $('draftProject').value || 'default',
    mask: state.mask
      ? {
          ...state.mask,
        }
      : null,
  };
  try {
    validateGptTask({
      ...base,
      variant: '',
      effectivePrompt: effectivePrompt({
        ...base,
        variant: '',
      }),
    });
    if (base.mask) base.maskValidation = await validateGptMask(base);
  } catch (e) {
    setStatus(e.message, true);
    return;
  }
  state.submitting = true;
  updateSend();
  try {
    if (state.editQueuedId) {
      const task = taskById(state.editQueuedId);
      if (!task || !['queued', 'retry_wait'].includes(task.status)) {
        notify('这张任务已开始或已结束，请重新选择。');
        state.editQueuedId = null;
        return;
      }
      Object.assign(task, base, {
        status: 'queued',
        nextRunAt: 0,
      });
      task.effectivePrompt = effectivePrompt(task);
      state.editQueuedId = null;
      renderEditContext();
      setStatus('排队任务已更新。');
    } else {
      const batchId = uid(),
        time = Date.now(),
        batch = [];
      for (const variant of variants)
        for (let i = 0; i < n; i++) {
          const id = uid();
          const t = {
            ...base,
            id,
            rootId: base.rootId || id,
            refs: copyRefs(base.refs),
            settings: {
              ...settings,
            },
            status: 'queued',
            createdAt: time,
            queueOrder: ++runtime.queueCounter,
            batchId,
            batchName: prompt.slice(0, 40),
            variant,
            variantAxis: $('variantAxis').value,
            variantCount: variants.length,
            attempts: 0,
            rateRetries: 0,
            favorite: false,
            discarded: false,
            currency: state.prefs.currency,
            pricePerImage: priceFor(settings),
            priceEstimate: null,
          };
          t.effectivePrompt = effectivePrompt(t);
          validateGptTask(t);
          batch.push(t);
        }
      state.tasks.unshift(...batch);
      setStatus(`已提交 ${batch.length} 张，可以继续编辑并提交下一次创作。`);
    }
    captureDraft();
    collapseAdvanced();
    state.filter = 'all';
    render();
    await persist();
    pump();
  } finally {
    state.submitting = false;
    updateSend();
  }
}
async function enqueueAgentTasks(run, plan, settings, refs) {
  if (!state.key) throw new Error('请先连接生图 API。');
  const imageSpecs = agentImageSpecs(plan);
  const approvedKey = state.key,
    approvedBase = state.base;
  const base = {
    prompt: plan.prompt,
    constraints: plan.constraints,
    exactText: plan.exactText,
    operation: plan.operation,
    baseAssetId: plan.baseId,
    approval: structuredClone(run.approval),
    confirmedRequirements: structuredClone(run.approval.requirements),
    settings,
    refs: copyRefs(refs),
    parentId: run.approval.parentId || null,
    rootId: taskById(run.approval.parentId)?.rootId || run.approval.parentId || null,
    projectId: run.snapshot.projectId,
    mask: run.snapshot.mask ? { ...run.snapshot.mask } : null,
  };
  base.effectivePrompt = effectivePrompt({ ...base, variant: '' });
  validateGptTask(base);
  const issues = executionIssues(plan, run.snapshot);
  if (issues.length) throw new Error(issues.join(' '));
  for (const ref of refs) { const image = await decodeImageBlob(ref.blob, ref.name); image.close(); }
  if (base.mask) base.maskValidation = await validateGptMask(base);
  if (run.stopped) throw new Error('本次 Agent 已停止。');
  if (state.key !== approvedKey || state.base !== approvedBase)
    throw new Error('生图连接已改变，请重新确认方案。');
  if (run.approval.signature !== planSignature(plan)) throw new Error('确认方案已变化，请重新确认。');
  const currentPrice = priceFor(settings);
  if (currentPrice !== run.prices[settings.model + settings.route]) throw new Error('估算价格已变化，请重新确认。');
  if (run.costLimit !== null && (currentPrice === null || plan.count * currentPrice > run.costLimit + 1e-8)) throw new Error('方案超过估算预算。');
  const batch = [];
  for (const spec of imageSpecs) {
    const id = uid();
    const task = {
      ...base,
      ...spec,
      id,
      rootId: base.rootId || id,
      refs: copyRefs(base.refs),
      settings: { ...settings },
      agentRunId: run.id,
      agentRequests: 0,
      agentPrepared: false,
      agentTried: [settings.model + settings.route],
      status: 'queued',
      createdAt: Date.now(),
      queueOrder: ++runtime.queueCounter,
      batchId: run.id,
      batchName: run.request.slice(0, 40),
      attempts: 0,
      rateRetries: 0,
      favorite: false,
      discarded: false,
      currency: run.currency,
      pricePerImage: run.prices[settings.model + settings.route] ?? null,
      priceEstimate: null,
    };
    task.effectivePrompt = effectivePrompt(task);
    validateGptTask(task);
    batch.push(task);
  }
  authorizeAgentRun(run);
  state.tasks.unshift(...batch);
  run.status = 'queued';
  run.taskIds = batch.map((t) => t.id);
  state.filter = 'all';
  render();
  if (!(await persist())) {
    state.tasks = state.tasks.filter((task) => !batch.some((item) => item.id === task.id));
    run.status = 'review'; run.taskIds = [];
    throw new Error('执行快照未能保存，请检查浏览器存储后重新确认。尚未提交生图请求。');
  }
  for (const task of batch) task.agentPrepared = true;
  pump();
}
function pump() {
  if (!state.ready || state.queuePaused) return;
  let capacity = currentLimit() - controllers.size;
  while (capacity-- > 0) {
    const t = state.tasks
      .filter(
        (t) => (!t.agentRunId || t.agentPrepared) && (t.status === 'queued' || (t.status === 'retry_wait' && t.nextRunAt <= Date.now())),
      )
      .sort((a, b) => a.queueOrder - b.queueOrder)[0];
    if (!t) break;
    if (!state.key) {
      setStatus('排队任务等待 API Key，请打开连接设置。', true);
      break;
    }
    runTask(t);
  }
}
function parseRetryAfter(response, retries) {
  const raw = response.headers.get('Retry-After');
  if (raw) {
    const seconds = Number(raw),
      date = Date.parse(raw);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : date - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.min(3600000, Math.max(1000, ms));
  }
  return Math.min(120000, 10000 * 2 ** retries);
}
async function runTask(t) {
  const controller = new AbortController(),
    key = state.key;
  controllers.set(t.id, controller);
  t.status = 'running';
  const agentRun = agentRunFor(t);
  if (agentRun) agentRun.status = 'running';
  t.startedAt = Date.now();
  t.finishedAt = null;
  t.error = '';
  delete t.resultWarning;
  delete t.maskReport;
  delete t.transportCorrection;
  delete t.rawOutputBlob;
  t.attempts++;
  let timedOut = false,
    responseStatus = 0,
    gotResult = false,
    requestSent = false,
    parsedResponse = false,
    acceptedResponse = false;
  const log = {
    id: uid(),
    taskId: t.id,
    at: t.startedAt,
    model: t.settings.model + t.settings.route,
    projectId: t.projectId,
    currency: t.currency || state.prefs.currency,
    pricePerImage: t.pricePerImage,
    status: 'running',
  };
  state.ledger.push(log);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, t.settings.timeout * 1000);
  render();
  await persist();
  try {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const s = t.settings;
    let prepared = await prepareGptRequest(t);
    t.submittedPrompt = prepared.params.prompt;
    t.requestSummary = { method: 'POST', path: prepared.path, n: prepared.params.n ?? 1,
      model: prepared.params.model, size: prepared.params.size, quality: prepared.params.quality,
      format: prepared.params.format || prepared.params.output_format,
      refIds: t.refs.map((ref) => ref.id), maskAssetId: t.mask?.assetId || null,
      maskMode: t.maskTransport, sourceRefIndex: t.outpaintSourceIndex };
    const headers = {
      ...prepared.headers,
      Authorization: 'Bearer ' + key,
    };
    reserveAgentRequest(t);
    renderAgentRuns();
    const recorded = await persist();
    if (t.agentRunId && !recorded) throw new Error('请求记录未能保存，尚未发送本次请求。');
    requestSent = true;
    let response = await fetch(s.base + prepared.path, {
      method: 'POST',
      headers,
      body: prepared.body,
      signal: controller.signal,
    });
    responseStatus = response.status;
    log.httpStatus = response.status;
    log.httpAttempts = 1;
    let raw = await response.text(),
      payload;
    try {
      payload = JSON.parse(raw);
      parsedResponse = true;
    } catch {
      if (response.status === 429)
        payload = {
          error: {
            message: '接口限流',
          },
        };
      else
        throw new Error(`接口返回了无法识别的内容（HTTP ${response.status}），请检查 API 地址。`);
    }
    const correction = gptFormatCorrection(response.status, payload, prepared);
    if (correction && agentCanRetry(t)) {
      recordAgentHealth(t, 'parameter_rejected', Date.now() - t.startedAt);
      prepared = await prepareGptRequest(t, correction);
      t.submittedPrompt = prepared.params.prompt;
      t.requestSummary = { ...t.requestSummary, path: prepared.path, n: prepared.params.n ?? 1, model: prepared.params.model };
      reserveAgentRequest(t);
      renderAgentRuns();
      const correctionRecorded = await persist();
      if (t.agentRunId && !correctionRecorded) throw new Error('兼容修正记录未能保存，未发送修正请求。');
      parsedResponse = false;
      response = await fetch(s.base + prepared.path, {
        method: 'POST',
        headers,
        body: prepared.body,
        signal: controller.signal,
      });
      responseStatus = response.status;
      log.httpStatus = response.status;
      log.httpAttempts++;
      raw = await response.text();
      try {
        payload = JSON.parse(raw);
        parsedResponse = true;
      } catch {
        throw new Error('格式字段兼容修正后，接口返回了无法识别的内容。');
      }
      if (response.ok && !payload.error) {
        state.prefs.gptTransport ||= {};
        state.prefs.gptTransport[s.base + '|' + prepared.params.model] = {
          formatField: correction,
          verifiedAt: Date.now(),
        };
        t.transportCorrection = '已按当前渠道修正格式字段';
      }
    }
    if (
      response.status === 429 &&
      state.prefs.autoRateRetry &&
      (t.rateRetries || 0) < 3 &&
      agentCanRetry(t)
    ) {
      const wait = parseRetryAfter(response, t.rateRetries || 0);
      t.rateRetries = (t.rateRetries || 0) + 1;
      t.nextRunAt = Date.now() + wait;
      t.status = 'retry_wait';
      t.error = `接口限流，${Math.ceil(wait / 1000)} 秒后重试（${t.rateRetries}/3）。`;
      log.status = 'rate_limited';
      recordAgentHealth(t, 'limited', Date.now() - t.startedAt);
      return;
    }
    if (!response.ok || payload.error) {
      const next = nextAgentCandidate(t, response.status, payload, validateGptTask);
      if (next) {
        recordAgentHealth(t, 'unavailable', Date.now() - t.startedAt);
        t.settings = next;
        t.pricePerImage = agentRunFor(t).prices[next.model] ?? null;
        t.status = 'queued';
        t.error = '原模型或线路明确不可用，已切换到授权候选：' + next.model;
        log.status = 'fallback';
        log.error = t.error;
        return;
      }
      let message = payload.error?.message || payload.message || `HTTP ${response.status}`;
      if (typeof message !== 'string') message = JSON.stringify(message);
      throw new Error(`HTTP ${response.status} · ${message.slice(0, 500)}`);
    }
    acceptedResponse = true;
    const item = payload.data?.[0],
      mime =
        payload.output_format === 'jpeg'
          ? 'jpeg'
          : payload.output_format === 'webp'
            ? 'webp'
            : s.format === 'jpeg'
              ? 'jpeg'
              : s.format === 'webp'
                ? 'webp'
                : 'png',
      src = item?.b64_json ? `data:image/${mime};base64,` + item.b64_json : item?.url;
    if (!validSrc(src)) throw new Error('接口未返回可用图片。请检查模型、路由和参数支持情况。');
    t.src = src;
    gotResult = true;
    if (agentRun) { agentRun.status = 'checking'; renderAgentRuns(); }
    t.usage = payload.usage || item.usage || null;
    log.usage = t.usage;
    try {
      const rawBlob = await fetchImage(src, controller.signal);
      t.outputBlob = rawBlob;
      t.outputCheck = await inspectOutput(rawBlob, s, payload.data.length);
      if (isOutpaintTask(t)) t.rawOutputBlob = rawBlob;
      try {
        t.outputBlob = await encodeGptOutput(t, rawBlob);
      } catch (e) {
        t.resultWarning = '图片已生成，但本地选区保护或格式处理失败：' + e.message;
      }
      if (t.outputBlob !== rawBlob) {
        const finalCheck = await inspectOutput(t.outputBlob, s);
        t.outputCheck.delivered = finalCheck.actual;
        t.outputCheck.issues.push(...finalCheck.issues);
      }
    } catch {
      t.outputBlob = null;
      t.outputCheck = { checkedAt: Date.now(), actual: null, issues: ['未能读取结果文件，请下载后核对。'], visualStatus: 'unchecked' };
      if (t.mask) t.resultWarning = '图片已生成，但未能读取原图做选区保护，请先下载检查。';
    }
    if (t.outputBlob) delete t.src;
    if (t.agentRunId) {
      const review = [...(t.outputCheck?.issues || []), '文案、Logo、主体结构与选区尚未完成视觉核对。'];
      t.resultWarning = [t.resultWarning, ...review].filter(Boolean).join(' ');
    }
    t.status = 'success';
    t.finishedAt = Date.now();
    t.priceEstimate = t.pricePerImage ?? null;
    log.status = 'success';
    log.estimatedCost = t.pricePerImage ?? null;
    recordAgentHealth(t, 'success', Date.now() - t.startedAt);
  } catch (e) {
    if (gotResult) {
      t.status = 'success';
      t.finishedAt = Date.now();
      log.status = 'success';
      log.estimatedCost = t.pricePerImage ?? null;
    } else {
      const ambiguous =
        requestSent && (timedOut ||
        e instanceof TypeError ||
        controller.signal.aborted ||
        responseStatus >= 500 ||
        (responseStatus === 200 && (!parsedResponse || acceptedResponse)));
      t.status = ambiguous ? 'unknown' : 'failed';
      t.error = timedOut
        ? `生成超过 ${t.settings.timeout} 秒，已停止等待。服务端可能仍在处理，请核实用量后再重试。`
        : controller.signal.aborted
          ? '已取消等待，服务端可能仍在处理。不会自动重试。'
          : e instanceof TypeError
            ? '网络请求中断，结果尚未确认。请核实服务端记录后再重试。'
            : e.message;
      t.finishedAt = Date.now();
      log.status = t.status;
      log.error = t.error;
      recordAgentHealth(t, ambiguous ? 'unknown' : 'failed', Date.now() - t.startedAt);
    }
  } finally {
    clearTimeout(timer);
    log.elapsedMs = Date.now() - t.startedAt;
    if (log.status === 'running') log.status = t.status;
    t.finishedAt = t.status === 'retry_wait' ? null : t.finishedAt;
    controllers.delete(t.id);
    syncAgentRuns();
    render();
    await persist();
    pump();
  }
}
async function retryTasks(tasks) {
  const eligible = tasks.filter((t) => !active(t) && existing(t));
  if (!eligible.length) return;
  if (eligible.some((t) => t.agentRunId)) {
    if (
      !(await askConfirm(
        '手动重新生成？',
        '这会发起新的生图请求，不计入原 Agent 方案预算，也不会自动切换模型。',
        '手动生成',
      ))
    )
      return;
  }
  if (!state.key) {
    showSettings();
    return;
  }
  if (
    eligible.some((t) => t.status === 'unknown') &&
    !(await askConfirm(
      '确认重新请求？',
      '这些任务的服务端结果尚未确认。重新请求可能再次计费，请先核实原任务用量。',
      '仍然重新生成',
    ))
  )
    return;
  for (const t of eligible) {
    if (active(t) || !existing(t)) continue;
    if (t.status === 'success') {
      const copy = {
        ...t,
        id: uid(),
        refs: copyRefs(t.refs),
        settings: {
          ...t.settings,
          base: state.base,
        },
        status: 'queued',
        createdAt: Date.now(),
        batchId: uid(),
        attempts: 0,
        rateRetries: 0,
        finishedAt: null,
        startedAt: null,
        outputBlob: null,
        src: null,
        usage: null,
        priceEstimate: null,
        queueOrder: ++runtime.queueCounter,
        favorite: false,
        discarded: false,
      };
      if (!t.parentId) copy.rootId = copy.id;
      delete copy.agentRunId;
      state.tasks.unshift(copy);
    } else {
      delete t.agentRunId;
      t.settings = {
        ...t.settings,
        base: state.base,
      };
      t.status = 'queued';
      t.rateRetries = 0;
      t.queueOrder = ++runtime.queueCounter;
      t.nextRunAt = 0;
      t.error = '';
      t.finishedAt = null;
    }
  }
  render();
  await persist();
  pump();
}
function cancelTask(t) {
  if (t.status === 'running') controllers.get(t.id)?.abort();
  else if (active(t)) {
    t.status = 'cancelled';
    t.finishedAt = Date.now();
    t.error = '尚未提交的任务已取消。';
    render();
    persist();
  }
  pump();
}
function mountFeaturesJobs() {
  $('composer').onsubmit = guard(async (e) => {
    e.preventDefault();
    await submit();
  });
  $('prompt').onkeydown = guard(async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      await submit();
    }
  });
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-elapsed]')) {
      const t = taskById(el.dataset.elapsed);
      if (t) el.textContent = duration(t);
    }
    for (const el of document.querySelectorAll('[data-retry-at]'))
      el.textContent =
        Math.max(0, Math.ceil((Number(el.dataset.retryAt) - Date.now()) / 1000)) + ' 秒后重试';
    if (
      state.ready &&
      !state.queuePaused &&
      state.tasks.some((t) => t.status === 'retry_wait' && t.nextRunAt <= Date.now())
    )
      pump();
  }, 1000);
}
export { cancelTask, effectivePrompt, enqueueAgentTasks, mountFeaturesJobs, pump, retryTasks };
