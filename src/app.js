import { seedPromptPresets } from './features/presets.js';
import { active, state, taskById } from './core/state.js';
import { imageURL, referenceURL } from './core/assets.js';
import { fileName } from './features/transfers.js';
import { captureDraft, renderEditContext, restoreDraft, updateSend } from './features/composer.js';
import { openDB, persist, readDB, storageGet } from './core/storage.js';
import { runtime } from './core/runtime.js';
import { effectivePrompt } from './features/jobs.js';
import { keyIndicator, parseBase } from './services/connection.js';
import { DEFAULT_BASE } from './core/config.js';
import { setStatus, storageWarning } from './ui/dialogs.js';
import { applyGptProfile, initializeModelControls } from './services/models.js';
import { initializeAccountControls, refreshSavedAccountBalance } from './services/account.js';
import { $ } from './core/dom.js';
import { renderProjects } from './features/library.js';
import { render } from './features/gallery.js';
import { writeImageDrag } from './core/drag-image.js';
import { recoverAgentSession } from './core/agent-session.js';
function startDrag(e, id, src, name) {
  writeImageDrag(e.dataTransfer, { id, src, name });
}
function normalizeTask(t) {
  t.refs = (t.refs || [])
    .filter((r) => r.blob instanceof Blob)
    .map((r) => ({
      ...r,
      role: r.role || 'general',
      note: r.note || '',
    }));
  t.settings = {
    model: 'gpt-image-2',
    route: '',
    size: '1024x1024',
    quality: 'medium',
    timeout: 300,
    base: state.base,
    ...t.settings,
  };
  t.projectId = t.projectId || 'default';
  t.batchId = t.batchId || t.id;
  t.rootId = t.rootId || t.id;
  t.queueOrder = t.queueOrder || ++runtime.queueCounter;
  t.effectivePrompt = t.effectivePrompt || effectivePrompt(t);
  if (t.status === 'running') {
    t.status = 'unknown';
    t.finishedAt = Date.now();
    t.error = '上次生成因页面关闭或刷新而中断，服务端结果待核实。不会自动重新提交。';
  }
  return t;
}
async function init() {
  state.key = storageGet('openlux_key') || '';
  try {
    state.base = parseBase(storageGet('openlux_base') || DEFAULT_BASE);
  } catch {}
  keyIndicator();
  let saved;
  try {
    runtime.db = await openDB();
    runtime.db.onversionchange = () => {
      runtime.db.close();
      runtime.db = null;
      storageWarning('存储已在其他窗口更新，请刷新页面。');
    };
    saved = await readDB();
  } catch {
    storageWarning('当前浏览器无法保存历史与草稿，关闭前请导出备份。');
  }
  if (Array.isArray(saved)) state.tasks = saved;
  else if (saved?.version) {
    for (const key of ['tasks', 'projects', 'presets', 'assets', 'ledger', 'agentRuns'])
      if (Array.isArray(saved[key])) state[key] = saved[key];
    state.prefs = {
      ...state.prefs,
      ...saved.prefs,
    };
    state.draft = saved.draft || {};
    state.queuePaused = !!saved.queuePaused;
  }
  if (!state.projects.some((p) => p.id === 'default'))
    state.projects.unshift({
      id: 'default',
      name: '未分类',
    });
  state.tasks = state.tasks.filter((t) => t && typeof t.id === 'string').map(normalizeTask);
  runtime.queueCounter = Math.max(
    runtime.queueCounter,
    ...state.tasks.map((t) => t.queueOrder || 0),
  );
  for (const log of state.ledger) if (log.status === 'running') log.status = 'unknown';
  for (const run of state.agentRuns) {
    recoverAgentSession(run, state.tasks);
  }
  seedPromptPresets();
  initializeModelControls();
  initializeAccountControls();
  $('concurrency').value = state.prefs.concurrency || 3;
  renderProjects();
  restoreDraft(state.draft);
  applyGptProfile(true);
  try {
    const fast = JSON.parse(storageGet('openlux_draft_text') || 'null');
    if (fast && fast.updatedAt > (state.draft.updatedAt || 0))
      $('prompt').value = fast.prompt || '';
  } catch {}
  if (
    state.editQueuedId &&
    !['queued', 'retry_wait'].includes(taskById(state.editQueuedId)?.status)
  ) {
    state.editQueuedId = null;
    renderEditContext();
  }
  state.ready = true;
  queueMicrotask(refreshSavedAccountBalance);
  captureDraft();
  render();
  updateSend();
  await persist();
  if (state.tasks.some((t) => ['queued', 'retry_wait'].includes(t.status))) {
    state.queuePaused = true;
    await persist();
    setStatus('已恢复未提交任务；打开队列并继续后才会生成。');
  }
}
function mountApp() {
  document.addEventListener('dragstart', (e) => {
    const refImg = e.target.closest('[data-ref-id]'),
      outImg = e.target.closest('[data-output]');
    if (refImg) {
      const ref = state.refs.find((r) => r.id === refImg.dataset.refId);
      if (ref) startDrag(e, ref.id, referenceURL(ref), ref.name);
    } else if (outImg) {
      const t = taskById(outImg.dataset.output);
      if (t) startDrag(e, t.id, imageURL(t), fileName(t));
    }
  });
  addEventListener('beforeunload', (e) => {
    if (state.ready) {
      captureDraft();
      persist();
    }
    if (state.tasks.some(active) || state.agentRuns.some((run) => run.status === 'planning')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  addEventListener('pagehide', () => {
    if (state.ready) {
      captureDraft();
      persist();
    }
  });
}
export { init, mountApp, normalizeTask };
