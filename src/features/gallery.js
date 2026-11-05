import { captureCards, transitionCards } from '../ui/motion.js';
import { active, existing, projectName, state, taskById, taskTitle } from '../core/state.js';
import { ROLE_NAMES, STATUS_NAMES } from '../core/config.js';
import { escapeHTML } from '../core/utils.js';
import { extension, imageURL, pruneURLs, referenceURL } from '../core/assets.js';
import { $, icon } from '../core/dom.js';
import { money } from '../services/pricing.js';
import { renderQueue } from './queue.js';
import { runtime } from '../core/runtime.js';
import { openDetail, renderDetail } from './detail.js';
import { persist } from '../core/storage.js';
import { continueTask, importTask } from './composer.js';
import { useAsReference } from './references.js';
import { download, saveBlob } from './transfers.js';
import { reblendOutpaint } from './outpaint.js';
import { cancelTask, retryTasks } from './jobs.js';
import { askConfirm, guard, notify } from '../ui/dialogs.js';
import { openEditor } from './editor.js';
import { renderAgentRuns } from './agent.js';
import { syncAgentRuns } from '../core/agent-budget.js';
function duration(t) {
  const sec = Math.max(
    0,
    Math.round(((t.finishedAt || Date.now()) - (t.startedAt || t.createdAt)) / 1000),
  );
  return sec < 60 ? sec + ' 秒' : Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
}
function filteredTasks() {
  return state.tasks
    .filter(existing)
    .filter((t) => state.projectFilter === 'all' || t.projectId === state.projectFilter)
    .filter((t) =>
      state.filter === 'all'
        ? !t.discarded
        : state.filter === 'active'
          ? active(t)
          : state.filter === 'favorite'
            ? t.favorite
            : state.filter === 'failed'
              ? ['failed', 'unknown'].includes(t.status)
              : t.discarded,
    )
    .filter(
      (t) =>
        !state.search ||
        [
          t.prompt,
          t.name,
          t.variant,
          projectName(t.projectId),
          ...(t.refs || []).map((r) => r.note),
        ]
          .join(' ')
          .toLowerCase()
          .includes(state.search),
    );
}
function taskMeta(t) {
  const s = t.settings || {};
  return `${s.model || ''}${s.route || ''} · ${s.size || 'auto'} · ${s.quality || 'medium'}`;
}
function cardHTML(t) {
  const busy = active(t),
    success = t.status === 'success',
    s = t.settings || {},
    label = STATUS_NAMES[t.status] || '生成失败';
  let visual = success
    ? `<img class="output" draggable="true" data-output="${t.id}" src="${escapeHTML(imageURL(t))}" alt="${escapeHTML(t.prompt)}" loading="lazy">`
    : `<div class="card-state">${icon(t.status === 'failed' || t.status === 'unknown' ? 'alert' : t.status === 'queued' || t.status === 'retry_wait' ? 'clock' : t.status === 'cancelled' ? 'close' : 'image').replace('<svg ', '<svg class="state-symbol" ')}<div class="state-title">${label}</div><div class="state-detail" title="${escapeHTML(t.error || '')}">${escapeHTML(t.error || (t.status === 'running' ? '画面正在成形，你可以继续下一次创作。' : t.status === 'retry_wait' ? '接口限流，将在等待结束后重试。' : t.status === 'queued' ? '轮到这张时会自动开始。' : '可导入编辑，或重新生成。'))}</div>${t.status === 'running' ? '<div class="skeleton"></div>' : ''}</div>`;
  const menu = [
    success
      ? '<button data-action="reference">用作参考图</button><button data-action="mask">涂抹局部修改</button><button data-action="adapt">裁切 / 扩展画布</button><button data-action="download">下载图片</button>'
      : '',
    t.rawOutputBlob
      ? '<button data-action="downloadRaw">下载模型原始结果</button><button data-action="reblend">重新自然融合（不生图）</button>'
      : '',
    '<button data-action="detail">作品与版本</button>',
    `<button data-action="discard">${t.discarded ? '恢复保留' : '淘汰这张'}</button>`,
    !busy
      ? '<button data-action="retry">' + (success ? '同样参数再生成' : '重新生成') + '</button>'
      : '<button data-action="cancel">取消任务</button>',
    '<button data-action="copy">复制提示词</button>',
    !busy ? '<button data-action="delete">删除记录</button>' : '',
  ].join('');
  return `<article class="card ${state.selection.has(t.id) ? 'selected' : ''} ${t.discarded ? 'discarded' : ''}" data-task-id="${t.id}" data-motion-state="${t.status}"><div class="card-visual">${visual}<span class="card-status ${['failed', 'unknown'].includes(t.status) ? 'failed' : ''}">${t.status === 'running' ? '<span class="spinner"></span>' : ''}${label}${busy ? ` · <span data-elapsed="${t.id}">${duration(t)}</span>` : ''}</span><div class="card-top-actions">${state.selecting ? `<input class="select-card" type="checkbox" data-select="${t.id}" aria-label="选择 ${escapeHTML(taskTitle(t))}" ${state.selection.has(t.id) ? 'checked' : ''}>` : ''}<button data-action="favorite" class="${t.favorite ? 'active' : ''}" title="${t.favorite ? '取消收藏' : '收藏'}" aria-label="${t.favorite ? '取消收藏' : '收藏'}">${icon('star')}</button></div></div><div class="card-body"><div class="card-prompt" title="${escapeHTML(t.prompt)}">${escapeHTML(t.name || t.prompt)}</div><div class="card-meta">${t.parentId ? '<span class="version-tag">修改分支</span>' : ''}${t.variant ? `<span class="variant-tag">${escapeHTML(t.variant)}</span>` : ''}${escapeHTML(taskMeta(t))}${t.maskReport?.outsidePreserved ? '<span class="mask-protected-tag"> · 选区外已保护</span>' : t.maskReport?.kind === 'outpaint' ? '<span class="mask-protected-tag"> · ' + (t.maskReport.corePreserved ? '原图优先融合' : '自然扩图') + '</span>' : ''}</div>${t.resultWarning ? '<p class="result-warning">' + escapeHTML(t.resultWarning) + '</p>' : ''}<div class="card-refs">${t.refs
    .slice(0, 3)
    .map(
      (r) =>
        `<img src="${referenceURL(r)}" alt="${escapeHTML(ROLE_NAMES[r.role] || '参考图')}" loading="lazy">`,
    )
    .join('')}<span>${t.refs.length ? t.refs.length + ' 张参考 · ' : ''}${new Date(
    t.createdAt,
  ).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })}${success ? ' · ' + duration(t) : ''}${t.priceEstimate !== null && t.priceEstimate !== undefined ? ' · 估 ' + money(t.priceEstimate, t.currency) : ''}</span></div><div class="card-actions">${success ? `<button class="btn continue" data-action="continue">继续改图 ${icon('arrow')}</button>` : t.status === 'queued' || t.status === 'retry_wait' ? '<button class="btn" data-action="queueEdit">编辑排队</button>' : t.status === 'running' ? '<button class="btn" data-action="cancel">取消</button>' : '<button class="btn" data-action="retry">' + icon('retry') + '重新生成</button>'}<button class="btn" data-action="edit">导入编辑</button><details class="card-menu"><summary aria-label="更多作品操作">···</summary><div class="card-menu-items">${menu}</div></details></div></div></article>`;
}
function render() {
  syncAgentRuns();
  renderAgentRuns();
  const previousCards = captureCards($('gallery'));
  const all = state.tasks.filter(existing),
    running = all.filter((t) => t.status === 'running').length,
    waiting = all.filter((t) => ['queued', 'retry_wait'].includes(t.status)).length;
  $('welcome').hidden = all.length > 0 || state.agentRuns.some((run) => !run.dismissed);
  $('galleryHead').hidden = !all.length;
  $('queueSummary').textContent =
    running || waiting
      ? `${running} 张生成中 · ${waiting} 张等待${state.queuePaused ? ' · 队列已暂停' : ''}`
      : `${all.length} 张创作`;
  $('queueCount').textContent = running + waiting;
  $('queueCount').hidden = running + waiting === 0;
  const queueLabel =
    running + waiting ? `生成队列 · ${running} 张生成中，${waiting} 张等待` : '生成队列';
  $('queueBtn').setAttribute('aria-label', queueLabel);
  $('queueBtn').dataset.tooltip =
    running + waiting ? `生成队列 · ${running + waiting} 项` : '生成队列';
  const filtered = filteredTasks(),
    shown = filtered.slice(0, state.visibleLimit),
    groups = new Map();
  for (const t of shown) {
    const id = t.batchId || t.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(t);
  }
  $('gallery').dataset.count = shown.length;
  $('gallery').classList.toggle('is-grouped', !!state.prefs.grouped);
  $('groupToggle').textContent = state.prefs.grouped ? '切为平铺' : '按创作分组';
  $('groupToggle').setAttribute('aria-pressed', String(!!state.prefs.grouped));
  $('gallery').innerHTML =
    (state.prefs.grouped
      ? Array.from(groups.values())
          .map((tasks) => {
            const first = tasks[0];
            return `<section class="batch-section"><div class="batch-heading"><strong>${escapeHTML(first.batchName || first.prompt.slice(0, 32) || '一次创作')}</strong><span>${escapeHTML(projectName(first.projectId))} · ${new Date(first.createdAt).toLocaleDateString('zh-CN')} · ${tasks.length} 张</span></div><div class="batch-grid">${tasks.map(cardHTML).join('')}</div></section>`;
          })
          .join('')
      : shown.map(cardHTML).join('')) ||
    (all.length
      ? '<p class="filter-empty">这里还没有对应的创作，试试其他项目或筛选条件。</p>'
      : '');
  transitionCards($('gallery'), previousCards);
  $('loadMore').hidden = shown.length >= filtered.length;
  $('loadMore').textContent = `显示更多（已显示 ${shown.length} / ${filtered.length}）`;
  document.querySelectorAll('.output').forEach(
    (img) =>
      (img.onerror = () => {
        if (img.parentElement.querySelector('.image-error')) return;
        const p = document.createElement('div');
        p.className = 'image-error';
        p.textContent = '图片链接无法读取或已过期，仍可导入原始素材重新生成。';
        img.parentElement.append(p);
      }),
  );
  updateFilters();
  updateBulk();
  pruneURLs();
  if ($('queueDlg').open) renderQueue();
  if ($('detailDlg').open && runtime.detailId && !$('detailDlg').contains(document.activeElement))
    renderDetail();
}
function updateFilters() {
  document
    .querySelectorAll('[data-filter]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));
}
function updateBulk() {
  for (const id of state.selection)
    if (!taskById(id) || !existing(taskById(id))) state.selection.delete(id);
  $('bulkBar').hidden = !state.selecting;
  $('selectedCount').textContent = `已选 ${state.selection.size} 张`;
  $('selectionToggle').setAttribute('aria-pressed', String(state.selecting));
  const selectionLabel = state.selecting ? '退出多选' : '多选作品';
  $('selectionToggle').setAttribute('aria-label', selectionLabel);
  $('selectionToggle').dataset.tooltip = selectionLabel;
  const selected = selectedTasks();
  $('compareBtn').disabled = selected.length !== 2 || selected.some((t) => t.status !== 'success');
  $('zipBtn').disabled = !selected.length;
  $('bulkRetry').disabled = !selected.some((t) =>
    ['failed', 'unknown', 'cancelled'].includes(t.status),
  );
}
function selectedTasks() {
  return state.tasks.filter((t) => state.selection.has(t.id) && existing(t));
}
function setSelectionMode(value) {
  state.selecting = value;
  if (!value) state.selection.clear();
  render();
}
function deleteTasks(tasks) {
  const ids = new Set(tasks.filter((t) => !active(t)).map((t) => t.id));
  for (const id of ids) {
    const t = taskById(id);
    if (!t) continue;
    if (state.tasks.some((x) => x.parentId === id)) {
      Object.assign(t, {
        status: 'deleted',
        refs: [],
        mask: null,
        outputBlob: null,
        rawOutputBlob: null,
        src: null,
      });
    } else state.tasks = state.tasks.filter((x) => x.id !== id);
    state.selection.delete(id);
  }
  let orphan;
  do {
    orphan = state.tasks.find(
      (t) => t.status === 'deleted' && !state.tasks.some((x) => x.parentId === t.id),
    );
    if (orphan) state.tasks = state.tasks.filter((t) => t.id !== orphan.id);
  } while (orphan);
  render();
  persist();
}
async function handleAction(t, action) {
  if (action === 'continue') await continueTask(t);
  if (action === 'edit') importTask(t);
  if (action === 'queueEdit') {
    state.queuePaused = true;
    importTask(t, true);
  }
  if (action === 'reference') await useAsReference(t);
  if (action === 'download') await download(t);
  if (action === 'reblend') await reblendOutpaint(t);
  if (action === 'downloadRaw' && t.rawOutputBlob)
    saveBlob(t.rawOutputBlob, `OpenLux-模型原始结果-${t.id}.${extension(t.rawOutputBlob)}`);
  if (action === 'detail') openDetail(t.id);
  if (action === 'favorite') {
    t.favorite = !t.favorite;
    if (t.favorite) t.discarded = false;
    render();
    persist();
  }
  if (action === 'discard') {
    t.discarded = !t.discarded;
    if (t.discarded) t.favorite = false;
    render();
    persist();
  }
  if (action === 'cancel') cancelTask(t);
  if (action === 'retry') await retryTasks([t]);
  if (action === 'delete' && !active(t)) {
    if (
      await askConfirm(
        '删除这张记录？',
        '图片和参考素材会从这条记录移除；有后续分支时会保留版本关系。',
        '删除',
      )
    )
      deleteTasks([t]);
  }
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(t.prompt);
      notify('提示词已复制。');
    } catch {
      importTask(t);
      notify('已导入输入框，可手动复制。');
    }
  }
  if (action === 'mask' || action === 'adapt') {
    await continueTask(t);
    await openEditor(action === 'mask' ? 'mask' : 'crop');
  }
}
function mountFeaturesGallery() {
  document.querySelectorAll('[data-filter]').forEach(
    (b) =>
      (b.onclick = () => {
        state.filter = b.dataset.filter;
        state.visibleLimit = 60;
        render();
      }),
  );
  $('projectFilter').onchange = () => {
    state.projectFilter = $('projectFilter').value;
    state.visibleLimit = 60;
    render();
  };
  $('search').oninput = () => {
    state.search = $('search').value.trim().toLowerCase();
    state.visibleLimit = 60;
    render();
  };
  $('loadMore').onclick = () => {
    state.visibleLimit += 60;
    render();
  };
  $('selectionToggle').onclick = () => setSelectionMode(!state.selecting);
  $('selectionDone').onclick = () => setSelectionMode(false);
  $('selectAllBtn').onclick = () => {
    const ids = filteredTasks()
      .slice(0, state.visibleLimit)
      .map((t) => t.id);
    const all = ids.every((id) => state.selection.has(id));
    for (const id of ids) all ? state.selection.delete(id) : state.selection.add(id);
    render();
  };
  $('groupToggle').onclick = () => {
    state.prefs.grouped = !state.prefs.grouped;
    render();
    persist();
  };
  $('gallery').onchange = (e) => {
    if (e.target.matches('[data-select]')) {
      e.target.checked
        ? state.selection.add(e.target.dataset.select)
        : state.selection.delete(e.target.dataset.select);
      e.target.closest('.card').classList.toggle('selected', e.target.checked);
      updateBulk();
    }
  };
  $('gallery').onclick = guard(async (e) => {
    const card = e.target.closest('[data-task-id]');
    if (!card) return;
    const t = taskById(card.dataset.taskId);
    if (!t) return;
    const b = e.target.closest('[data-action]');
    if (b) {
      card.querySelector('details')?.removeAttribute('open');
      await handleAction(t, b.dataset.action);
    } else if (e.target.closest('.output')) openDetail(t.id);
  });
  $('bulkFavorite').onclick = () => {
    for (const t of selectedTasks()) {
      t.favorite = true;
      t.discarded = false;
    }
    render();
    persist();
  };
  $('bulkDiscard').onclick = () => {
    for (const t of selectedTasks()) {
      t.discarded = true;
      t.favorite = false;
    }
    render();
    persist();
  };
  $('bulkRetry').onclick = guard(() =>
    retryTasks(
      selectedTasks().filter((t) => ['failed', 'unknown', 'cancelled'].includes(t.status)),
    ),
  );
  $('bulkDelete').onclick = guard(async () => {
    const tasks = selectedTasks().filter((t) => !active(t));
    if (
      tasks.length &&
      (await askConfirm(
        `删除 ${tasks.length} 张记录？`,
        '只删除已结束的记录，进行中的任务会保留。',
        '删除',
      ))
    )
      deleteTasks(tasks);
  });
  $('clearBtn').onclick = guard(async () => {
    const tasks = state.tasks.filter(
      (t) =>
        existing(t) &&
        !active(t) &&
        (state.projectFilter === 'all' || t.projectId === state.projectFilter),
    );
    if (!tasks.length) {
      notify('没有可清理的已结束记录。');
      return;
    }
    if (
      await askConfirm(
        '清理已结束的记录？',
        `将清理${state.projectFilter === 'all' ? '全部项目' : projectName(state.projectFilter)}中的 ${tasks.length} 张记录。请先下载需要的图片。`,
        '清空记录',
      )
    )
      deleteTasks(tasks);
  });
}
export {
  duration,
  handleAction,
  mountFeaturesGallery,
  render,
  selectedTasks,
  taskMeta,
  updateBulk,
};
