import { revealContent } from '../ui/motion.js';
import { $ } from '../core/dom.js';
import { existing, state } from '../core/state.js';
import { escapeHTML, uid } from '../core/utils.js';
import { runtime } from '../core/runtime.js';
import { askConfirm, askName, guard, notify, setStatus, showDialog } from '../ui/dialogs.js';
import { copyRefs, referenceURL } from '../core/assets.js';
import { focusComposer, readDraft, restoreDraft, scheduleDraft } from './composer.js';
import { persist } from '../core/storage.js';
import { MAX_REFS } from '../core/config.js';
import { renderRefs } from './references.js';
import { render } from './gallery.js';
import { exportBackup, exportUsage } from './transfers.js';
import { money } from '../services/pricing.js';
function renderProjects() {
  const pvalue = $('projectFilter').value || state.projectFilter,
    dvalue = $('draftProject').value || state.draft.projectId || 'default';
  $('projectFilter').innerHTML =
    '<option value="all">全部项目</option>' +
    state.projects.map((p) => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('');
  $('draftProject').innerHTML = state.projects
    .map((p) => `<option value="${p.id}">${escapeHTML(p.name)}</option>`)
    .join('');
  $('projectFilter').value = state.projects.some((p) => p.id === pvalue) ? pvalue : 'all';
  $('draftProject').value = state.projects.some((p) => p.id === dvalue) ? dvalue : 'default';
  state.projectFilter = $('projectFilter').value;
}
function openLibrary(tab = 'presets') {
  runtime.libraryTab = tab;
  renderLibrary();
  showDialog('libraryDlg');
}
function libraryThumbs(refs) {
  return `<div class="library-thumbs">${refs
    .slice(0, 6)
    .map((r) => `<img src="${referenceURL(r)}" alt="${escapeHTML(r.name)}" loading="lazy">`)
    .join('')}</div>`;
}
function renderLibrary() {
  document
    .querySelectorAll('[data-library-tab]')
    .forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.libraryTab === runtime.libraryTab)),
    );
  let content = '';
  if (runtime.libraryTab === 'presets')
    content =
      '<div class="library-toolbar"><button class="btn outlined" data-lib-action="savePreset">保存当前输入为预设</button></div>' +
      (state.presets.length
        ? `<div class="library-list">${state.presets.map((p) => `<article class="library-item" data-lib-id="${p.id}"><div class="item-content"><h3>${escapeHTML(p.name)}</h3><p>${escapeHTML(p.prompt || '未填写画面描述')}</p>${libraryThumbs(p.refs || [])}</div><div class="inline"><button class="btn outlined" data-lib-action="applyPreset">使用</button><button class="btn" data-lib-action="renamePreset">改名</button><button class="btn" data-lib-action="deletePreset">删除</button></div></article>`).join('')}</div>`
        : '<div class="empty-library">把常用的提示词、参考图、参数和保留要求一起存下来，下次直接套用。</div>');
  if (runtime.libraryTab === 'assets')
    content =
      '<div class="library-toolbar"><button class="btn outlined" data-lib-action="saveAssets">保存当前参考图为素材包</button></div>' +
      (state.assets.length
        ? `<div class="library-list">${state.assets.map((p) => `<article class="library-item" data-lib-id="${p.id}"><div class="item-content"><h3>${escapeHTML(p.name)}</h3><p>${p.refs.length} 张参考图 · 已保存各自用途和说明</p>${libraryThumbs(p.refs)}</div><div class="inline"><button class="btn outlined" data-lib-action="applyAssets">加入输入框</button><button class="btn" data-lib-action="renameAssets">改名</button><button class="btn" data-lib-action="deleteAssets">删除</button></div></article>`).join('')}</div>`
        : '<div class="empty-library">可以按产品、人物或风格保存素材包，使用时加入当前输入框。</div>');
  if (runtime.libraryTab === 'projects')
    content =
      '<div class="library-toolbar"><button class="btn outlined" data-lib-action="newProject">新建项目</button></div><div class="library-list">' +
      state.projects
        .map(
          (p) =>
            `<article class="library-item" data-lib-id="${p.id}"><div class="item-content"><h3>${escapeHTML(p.name)}</h3><p>${state.tasks.filter((t) => existing(t) && t.projectId === p.id).length} 张创作</p></div><div class="inline"><button class="btn outlined" data-lib-action="useProject">打开</button><button class="btn" data-lib-action="renameProject">改名</button>${p.id !== 'default' ? '<button class="btn" data-lib-action="deleteProject">移至未分类</button>' : ''}</div></article>`,
        )
        .join('') +
      '</div>';
  if (runtime.libraryTab === 'usage') content = usageHTML();
  const changed = $('libraryContent').dataset.tab !== runtime.libraryTab;
  $('libraryContent').innerHTML = content;
  $('libraryContent').dataset.tab = runtime.libraryTab;
  if (changed) {
    $('libraryContent').scrollTop = 0;
    revealContent($('libraryContent'));
  }
}
async function savePreset() {
  const d = readDraft();
  if (!d.prompt.trim() && !d.refs.length) throw new Error('先填写提示词或添加参考图。');
  const name = await askName('保存个人预设', d.prompt.trim().slice(0, 24));
  if (!name) return;
  state.presets.unshift({
    id: uid(),
    name,
    prompt: d.prompt,
    refs: copyRefs(d.refs),
    settings: {
      ...d.settings,
    },
    constraints: d.constraints,
    variantAxis: d.variantAxis,
    variants: d.variants,
    n: d.n,
    mask: d.mask
      ? {
          ...d.mask,
        }
      : null,
    createdAt: Date.now(),
  });
  await persist();
  if ($('libraryDlg').open) renderLibrary();
  notify('预设已保存，包含参考图、用途、参数和蒙版。');
}
async function saveAssets() {
  if (!state.refs.length) throw new Error('先添加参考图。');
  const name = await askName('保存参考图素材包');
  if (!name) return;
  state.assets.unshift({
    id: uid(),
    name,
    refs: copyRefs(state.refs),
    createdAt: Date.now(),
  });
  await persist();
  if ($('libraryDlg').open) renderLibrary();
  notify('素材包已保存。');
}
function usageHTML() {
  const logs = state.ledger,
    done = logs.filter((l) => l.status === 'success'),
    settled = logs.filter((l) => !['running', 'rate_limited'].includes(l.status)),
    rate = settled.length ? Math.round((done.length / settled.length) * 100) + '%' : '—',
    avg = done.length
      ? Math.round(done.reduce((sum, l) => sum + (l.elapsedMs || 0), 0) / done.length / 1000) +
        ' 秒'
      : '—';
  const totals = {};
  for (const l of logs)
    if (l.status === 'success' && l.estimatedCost != null)
      totals[l.currency] = (totals[l.currency] || 0) + Math.round(l.estimatedCost * 100);
  const grouped = new Map();
  for (const l of logs) {
    if (!grouped.has(l.model))
      grouped.set(l.model, {
        requests: 0,
        success: 0,
        tokens: 0,
        knownTokens: false,
      });
    const g = grouped.get(l.model);
    g.requests++;
    if (l.status === 'success') g.success++;
    if (l.usage?.total_tokens != null) {
      g.tokens += Number(l.usage.total_tokens) || 0;
      g.knownTokens = true;
    }
  }
  return `<div class="usage-strip"><div><small>请求次数</small><strong>${logs.length}</strong></div><div><small>成功率（不含限流拒绝）</small><strong>${rate}</strong></div><div><small>成功平均耗时</small><strong>${avg}</strong></div></div><p class="tiny-note">成功请求的已配置估算：${
    Object.keys(totals).length
      ? Object.entries(totals)
          .map(([c, v]) => money(v / 100, c))
          .join(' · ')
      : '尚未配置价格'
  }。结果待核实的请求可能产生费用，此处未计入。用量以服务商账单为准。</p><div style="overflow-x:auto"><table class="usage-table"><thead><tr><th>模型 / 路由</th><th>请求</th><th>成功</th><th>返回 tokens</th></tr></thead><tbody>${
    Array.from(grouped)
      .map(
        ([model, g]) =>
          `<tr><td>${escapeHTML(model)}</td><td>${g.requests}</td><td>${g.success}</td><td>${g.knownTokens ? g.tokens.toLocaleString('zh-CN') : '—'}</td></tr>`,
      )
      .join('') || '<tr><td colspan="4">还没有请求记录。</td></tr>'
  }</tbody></table></div><div class="library-toolbar" style="margin-top:24px"><button class="btn outlined" data-lib-action="exportUsage">导出用量明细</button><button class="btn outlined" data-lib-action="backup">导出完整备份</button><button class="btn" data-lib-action="restore">导入备份</button></div><p class="tiny-note">备份包含本机项目、图片、参考素材、预设、草稿与用量记录，不含 API Key。导入采用合并方式，正在执行的请求不会被覆盖。</p>`;
}
function mountFeaturesLibrary() {
  $('libraryBtn').onclick = () => openLibrary();
  $('projectsBtn').onclick = () => openLibrary('projects');
  document.querySelectorAll('[data-library-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        runtime.libraryTab = b.dataset.libraryTab;
        renderLibrary();
      }),
  );
  $('savePresetBtn').onclick = guard(savePreset);
  $('saveAssetsBtn').onclick = guard(saveAssets);
  $('libraryContent').onclick = guard(async (e) => {
    const action = e.target.closest('[data-lib-action]')?.dataset.libAction,
      id = e.target.closest('[data-lib-id]')?.dataset.libId;
    if (!action) return;
    if (action === 'savePreset') await savePreset();
    if (action === 'saveAssets') await saveAssets();
    if (action === 'applyPreset') {
      const p = state.presets.find((p) => p.id === id);
      if (!p) return;
      restoreDraft({
        ...p,
        projectId: $('draftProject').value,
        parentId: null,
        editQueuedId: null,
      });
      scheduleDraft();
      focusComposer();
      setStatus('预设已导入，可以继续修改。');
    }
    if (action === 'applyAssets') {
      const pack = state.assets.find((p) => p.id === id);
      if (!pack) return;
      if (state.refs.length + pack.refs.length > MAX_REFS)
        throw new Error('加入后会超过 16 张，请先移除部分参考图。');
      state.refs.push(
        ...pack.refs.map((r) => ({
          ...r,
          id: uid(),
        })),
      );
      renderRefs();
      scheduleDraft();
      focusComposer();
      setStatus(`已加入「${pack.name}」的 ${pack.refs.length} 张参考图。`);
    }
    for (const [type, key] of [
      ['Preset', 'presets'],
      ['Assets', 'assets'],
    ]) {
      if (action === 'rename' + type) {
        const item = state[key].find((p) => p.id === id);
        const name = await askName('修改名称', item.name);
        if (name) item.name = name;
      }
      if (action === 'delete' + type) {
        if (
          await askConfirm(
            '删除这项收藏？',
            '只从素材库删除，已生成记录与当前输入不会受影响。',
            '删除',
          )
        )
          state[key] = state[key].filter((p) => p.id !== id);
      }
    }
    if (action === 'newProject') {
      const name = await askName('新建项目');
      if (name) {
        const p = {
          id: uid(),
          name,
        };
        state.projects.push(p);
        renderProjects();
        $('draftProject').value = p.id;
        scheduleDraft();
      }
    }
    if (action === 'renameProject') {
      const p = state.projects.find((p) => p.id === id);
      const name = await askName('修改项目名称', p.name);
      if (name) p.name = name;
      renderProjects();
    }
    if (action === 'useProject') {
      state.projectFilter = id;
      $('projectFilter').value = id;
      $('draftProject').value = id;
      render();
      scheduleDraft();
      $('libraryDlg').close();
    }
    if (action === 'deleteProject' && id !== 'default') {
      if (
        await askConfirm('将项目内容移至未分类？', '作品会保留，项目名称将被移除。', '移至未分类')
      ) {
        for (const t of state.tasks) if (t.projectId === id) t.projectId = 'default';
        if ($('draftProject').value === id) $('draftProject').value = 'default';
        state.projects = state.projects.filter((p) => p.id !== id);
        state.projectFilter = 'all';
        renderProjects();
        render();
        scheduleDraft();
      }
    }
    if (action === 'backup') await exportBackup();
    if (action === 'restore') $('backupInput').click();
    if (action === 'exportUsage') await exportUsage();
    await persist();
    if ($('libraryDlg').open) renderLibrary();
  });
}
export { libraryThumbs, mountFeaturesLibrary, renderLibrary, renderProjects };
