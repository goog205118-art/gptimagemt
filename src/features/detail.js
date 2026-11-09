import { revealContent } from '../ui/motion.js';
import { runtime } from '../core/runtime.js';
import { guard, showDialog } from '../ui/dialogs.js';
import { projectName, state, taskById, taskTitle } from '../core/state.js';
import { $, icon } from '../core/dom.js';
import { escapeHTML } from '../core/utils.js';
import { imageURL } from '../core/assets.js';
import { STATUS_NAMES } from '../core/config.js';
import { handleAction, render, taskMeta } from './gallery.js';
import { libraryThumbs } from './library.js';
import { money } from '../services/pricing.js';
import { effectivePrompt } from './jobs.js';
import { compareTasks } from './comparison.js';
import { persist } from '../core/storage.js';
function openDetail(id) {
  runtime.detailId = id;
  renderDetail();
  showDialog('detailDlg');
}
function lineage(t) {
  let current = t,
    seen = new Set();
  while (current.parentId && taskById(current.parentId) && !seen.has(current.id)) {
    seen.add(current.id);
    current = taskById(current.parentId);
  }
  const root = current.id;
  return state.tasks.filter((x) => x.rootId === root || x.id === root || x.rootId === t.rootId);
}
function depth(t) {
  let n = 0,
    seen = new Set();
  while (t?.parentId && n < 20 && !seen.has(t.id)) {
    seen.add(t.id);
    n++;
    t = taskById(t.parentId);
  }
  return n;
}
function renderDetail() {
  const t = taskById(runtime.detailId);
  if (!t) {
    $('detailDlg').close();
    return;
  }
  $('detailTitle').textContent = taskTitle(t);
  $('detailMedia').innerHTML =
    t.status === 'success'
      ? `<img draggable="true" data-output="${t.id}" src="${escapeHTML(imageURL(t))}" alt="${escapeHTML(t.prompt)}" title="可拖出原图；若 PS 不接收，可使用下方复制图片或下载 PNG">`
      : `<div class="card-state"><div class="state-title">${STATUS_NAMES[t.status]}</div><div class="state-detail">${escapeHTML(t.error || '')}</div></div>`;
  if ($('detailMedia').dataset.version !== t.id + ':' + t.status) revealContent($('detailMedia'));
  $('detailMedia').dataset.version = t.id + ':' + t.status;
  $('taskNameInput').value = t.name || '';
  const parent = taskById(t.parentId);
  $('detailActions').innerHTML =
    (t.status === 'success'
      ? '<button class="btn primary" data-detail-action="continue">继续改图</button><button class="btn" data-detail-action="mask">涂抹局部</button><button class="btn" data-detail-action="adapt">裁切 / 扩展</button><button class="btn" data-detail-action="copyImage">复制图片到 PS</button><button class="btn" data-detail-action="downloadPng">下载 PNG</button><button class="btn" data-detail-action="download">原图</button>'
      : '') +
    (t.rawOutputBlob
      ? '<button class="btn" data-detail-action="reblend">重新自然融合（不生图）</button>'
      : '') +
    `<button class="btn" data-detail-action="edit">导入原始输入</button>${parent?.status === 'success' && t.status === 'success' ? '<button class="btn" data-detail-action="compareParent">前后对比</button>' : ''}`;
  const logs = state.ledger.filter((l) => l.taskId === t.id);
  if (t.status === 'success') $('detailActions').insertAdjacentHTML('afterbegin', '<button class="btn" data-detail-action="agent">Agent 继续本版</button>');
  $('detailInfo').innerHTML =
    `${t.resultWarning ? '<p class="result-warning">' + escapeHTML(t.resultWarning) + '</p>' : ''}<div class="detail-prompt">${escapeHTML(t.prompt)}</div><div class="detail-info-line">${escapeHTML(taskMeta(t))}<br>${escapeHTML(projectName(t.projectId))} · ${new Date(t.createdAt).toLocaleString('zh-CN')}${t.constraints ? '<br>保持：' + escapeHTML(t.constraints) : ''}${t.variant ? '<br>本次变量：' + escapeHTML(t.variant) : ''}</div>${libraryThumbs(t.refs)}<details class="attempt-list"><summary>请求与用量记录（${logs.length}）</summary>${logs.map((l) => `<div>${new Date(l.at).toLocaleString('zh-CN')} · ${escapeHTML(l.status)} · ${Math.round((l.elapsedMs || 0) / 1000)} 秒${l.httpStatus ? ' · HTTP ' + l.httpStatus : ''}${l.estimatedCost != null ? ' · 估 ' + money(l.estimatedCost, l.currency) : ''}${l.usage ? '<pre>' + escapeHTML(JSON.stringify(l.usage, null, 2)) + '</pre>' : ''}</div>`).join('') || (t.postprocessOnly ? '<div>本地重新融合，没有新增生图请求或费用。</div>' : '<div>此记录来自旧版本，尚无请求明细。</div>')}</details><details class="attempt-list"><summary>实际提交的完整提示词</summary><div class="detail-prompt">${escapeHTML(t.submittedPrompt || t.effectivePrompt || effectivePrompt(t))}</div></details>`;
  const family = lineage(t).sort((a, b) => a.createdAt - b.createdAt);
  if (t.outputCheck) {
    const a = t.outputCheck.actual;
    $('detailInfo').insertAdjacentHTML('beforeend', `<details class="attempt-list"><summary>文件检查与创作核对</summary><p>${a ? `${a.width} × ${a.height} · ${escapeHTML(a.format)} · ${a.bytes} 字节` : '文件未完成解码检查'}</p><p>${escapeHTML(t.outputCheck.issues.join(' ') || '基础文件检查通过。')} 文案、Logo、结构和选区仍待人工核对。</p></details>`);
  }
  if (t.confirmedRequirements) $('detailInfo').insertAdjacentHTML('beforeend', `<details class="attempt-list"><summary>本版本已确认要求</summary><p>${escapeHTML(t.confirmedRequirements.values.constraints || '未指定保留项')}</p><pre>${escapeHTML(t.confirmedRequirements.values.exactText || '')}</pre><p>方案版本 ${t.approval?.revision || 1} · 底图 ${escapeHTML(t.baseAssetId || t.approval?.plan?.baseId || '新建')}</p></details>`);
  $('versionList').innerHTML = family
    .map(
      (v) =>
        `<button class="version-row ${v.id === t.id ? 'current' : ''}" data-version="${v.id}" style="padding-left:${Math.min(depth(v), 5) * 9 + 8}px">${v.status === 'success' ? `<img src="${escapeHTML(imageURL(v))}" alt="版本缩略图" loading="lazy">` : icon('branch')}<div class="version-copy"><span>${escapeHTML(taskTitle(v))}</span><small>${STATUS_NAMES[v.status]} · ${new Date(
          v.createdAt,
        ).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        })}</small></div></button>`,
    )
    .join('');
}
function mountFeaturesDetail() {
  $('detailMedia').onclick = () => {
    const t = taskById(runtime.detailId);
    if (t?.status === 'success') {
      compareTasks([t, t]);
    }
  };
  $('versionList').onclick = (e) => {
    const id = e.target.closest('[data-version]')?.dataset.version;
    if (id) {
      runtime.detailId = id;
      renderDetail();
    }
  };
  $('taskNameInput').onchange = () => {
    const t = taskById(runtime.detailId);
    if (t) {
      t.name = $('taskNameInput').value.trim();
      persist();
      render();
      $('detailTitle').textContent = taskTitle(t);
    }
  };
  $('detailActions').onclick = guard(async (e) => {
    const action = e.target.closest('[data-detail-action]')?.dataset.detailAction,
      t = taskById(runtime.detailId);
    if (!action || !t) return;
    if (action === 'compareParent') {
      compareTasks([taskById(t.parentId), t]);
      return;
    }
    await handleAction(t, action);
  });
}
export { mountFeaturesDetail, openDetail, renderDetail };
