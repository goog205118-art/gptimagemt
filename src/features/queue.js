import { active, projectName, state, taskById, taskTitle } from '../core/state.js';
import { $ } from '../core/dom.js';
import { escapeHTML } from '../core/utils.js';
import { STATUS_NAMES } from '../core/config.js';
import { render, taskMeta } from './gallery.js';
import { guard, notify, showDialog } from '../ui/dialogs.js';
import { persist } from '../core/storage.js';
import { cancelTask, pump } from './jobs.js';
import { importTask } from './composer.js';
import { revealContent } from '../ui/motion.js';
function renderQueue() {
  const tasks = state.tasks
    .filter(active)
    .sort((a, b) =>
      a.status === 'running' && b.status !== 'running'
        ? -1
        : b.status === 'running' && a.status !== 'running'
          ? 1
          : a.queueOrder - b.queueOrder,
    );
  $('pauseQueue').textContent = state.queuePaused ? '继续队列' : '暂停队列';
  $('queueStatus').textContent =
    `${tasks.filter((t) => t.status === 'running').length} 张生成中 · ${tasks.filter((t) => t.status !== 'running').length} 张等待${state.queuePaused ? ' · 已暂停' : ''}`;
  const signature = tasks.map((t) => t.id + ':' + t.status).join(',');
  const changed = $('queueList').dataset.signature !== signature;
  $('queueList').innerHTML =
    tasks
      .map(
        (t) =>
          `<div class="queue-row" data-queue-id="${t.id}"><div class="queue-info"><strong>${escapeHTML(taskTitle(t))}</strong><small>${STATUS_NAMES[t.status]}${t.status === 'retry_wait' ? ` · <span data-retry-at="${t.nextRunAt}"></span>` : ''} · ${escapeHTML(projectName(t.projectId))}<br>${escapeHTML(taskMeta(t))}</small></div><div class="inline">${t.status !== 'running' ? '<button class="btn" data-queue-action="up" aria-label="任务前移">↑</button><button class="btn" data-queue-action="down" aria-label="任务后移">↓</button><button class="btn" data-queue-action="edit">编辑</button>' : ''}<button class="btn" data-queue-action="cancel">取消</button></div></div>`,
      )
      .join('') || '<div class="empty-library">当前没有进行中或排队的任务。</div>';
  $('queueList').dataset.signature = signature;
  if (changed) revealContent($('queueList'));
}
function mountFeaturesQueue() {
  $('queueBtn').onclick = () => {
    renderQueue();
    showDialog('queueDlg');
  };
  $('pauseQueue').onclick = () => {
    state.queuePaused = !state.queuePaused;
    persist();
    render();
    pump();
  };
  $('queueList').onclick = guard(async (e) => {
    const id = e.target.closest('[data-queue-id]')?.dataset.queueId,
      action = e.target.closest('[data-queue-action]')?.dataset.queueAction,
      t = taskById(id);
    if (!t || !action) return;
    if (action === 'cancel') cancelTask(t);
    if (action === 'edit' && t.status !== 'running') {
      state.queuePaused = true;
      importTask(t, true);
      await persist();
      notify('队列已暂停。更新任务后，可到队列继续生成。');
    }
    if (action === 'up' || action === 'down') {
      const queue = state.tasks
        .filter((x) => ['queued', 'retry_wait'].includes(x.status))
        .sort((a, b) => a.queueOrder - b.queueOrder);
      const i = queue.indexOf(t),
        j = i + (action === 'up' ? -1 : 1);
      if (j >= 0 && j < queue.length)
        [t.queueOrder, queue[j].queueOrder] = [queue[j].queueOrder, t.queueOrder];
      renderQueue();
      await persist();
    }
  });
}
export { mountFeaturesQueue, renderQueue };
