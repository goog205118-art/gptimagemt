import { projectName, state, taskTitle } from '../core/state.js';
import { extension, outputBlob, validSrc } from '../core/assets.js';
import { askConfirm, guard, notify } from '../ui/dialogs.js';
import { render, selectedTasks, taskMeta, updateBulk } from './gallery.js';
import { $ } from '../core/dom.js';
import { effectivePrompt } from './jobs.js';
import { flushDraft } from './composer.js';
import { persist, rootSnapshot } from '../core/storage.js';
import { DEFAULT_BASE, STATUS_NAMES } from '../core/config.js';
import { parseBase } from '../services/connection.js';
import { normalizeTask } from '../app.js';
import { renderLibrary, renderProjects } from './library.js';
import { photoshopPng } from '../services/desktop-image.js';
import { recoverAgentSession } from '../core/agent-session.js';
function safeName(value) {
  return (
    String(value || 'openlux')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/, '')
      .slice(0, 90) || 'openlux'
  );
}
function fileName(t) {
  return `${safeName(projectName(t.projectId)).slice(0, 20)}-${safeName(t.name || t.prompt).slice(0, 24)}${t.variant ? '-' + safeName(t.variant).slice(0, 20) : ''}-${t.id.slice(0, 8)}.${extension(t.outputBlob) || 'png'}`;
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = safeName(name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function download(t) {
  try {
    const blob = await outputBlob(t);
    const name = fileName({
      ...t,
      outputBlob: blob,
    });
    saveBlob(blob, name);
  } catch (e) {
    notify('原图暂不可直接下载，正在打开链接，可尝试右键保存。');
    if (validSrc(t.src)) window.open(t.src, '_blank', 'noopener,noreferrer');
  }
}
async function copyImageForPhotoshop(t) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    throw new Error('当前浏览器不能复制图片，请使用“下载 PNG”后放入 PS。');
  const png = outputBlob(t).then(photoshopPng);
  png.catch(() => {});
  // Start the clipboard request during the click's user activation; conversion
  // can then finish through the promised ClipboardItem data.
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    notify('已复制原尺寸 PNG。在 PS 中打开画布后按 Ctrl / ⌘ + V 粘贴。');
  } catch {
    throw new Error('图片未能复制。请允许本次剪贴板操作，或使用“下载 PNG”后放入 PS。');
  }
}
async function downloadPhotoshopPng(t) {
  const blob = await photoshopPng(await outputBlob(t));
  saveBlob(blob, fileName({ ...t, outputBlob: blob }));
  notify('已下载原尺寸 PNG，可从下载列表或文件夹拖入 PS。');
}
const crcTable = Array.from(
  {
    length: 256,
  },
  (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  },
);
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zipHeader(length) {
  const bytes = new Uint8Array(length);
  return {
    bytes,
    view: new DataView(bytes.buffer),
  };
}
async function makeZip(files) {
  const chunks = [],
    directory = [],
    encoder = new TextEncoder();
  let offset = 0,
    totalSize = 0;
  for (const file of files) {
    const name = encoder.encode(file.name),
      data = new Uint8Array(await file.blob.arrayBuffer());
    totalSize += data.byteLength;
    if (totalSize > 1.5 * 1024 ** 3) throw new Error('导出内容超过 1.5 GB，请分批选择。');
    const crc = crc32(data),
      local = zipHeader(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x800, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    chunks.push(local.bytes, name, data);
    const central = zipHeader(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x800, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, data.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    directory.push(central.bytes, name);
    offset += 30 + name.length + data.length;
  }
  const centralLength = directory.reduce((sum, x) => sum + x.length, 0),
    end = zipHeader(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralLength, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end.bytes], {
    type: 'application/zip',
  });
}
function exportMetadata(t) {
  const { outputBlob, rawOutputBlob, refs, mask, src, ...metadata } = t;
  return {
    ...metadata,
    outputFile: t.status === 'success' ? 'images/' + fileName(t) : null,
    references: refs.map((r, i) => ({
      name: r.name,
      role: r.role,
      note: r.note,
      file: `references/${t.id}/${i + 1}-${safeName(r.name)}`,
    })),
    maskFile: mask ? `masks/${t.id}.png` : null,
  };
}
let exporting = false;
async function exportSelected() {
  if (exporting) return;
  const tasks = structuredClone(selectedTasks());
  if (!tasks.length) throw new Error('先选择需要导出的记录。');
  exporting = true;
  $('zipBtn').disabled = true;
  notify('正在整理图片和提示词…');
  try {
    const files = [],
      errors = [],
      metadata = [];
    for (const t of tasks) {
      const meta = exportMetadata(t);
      if (t.status === 'success') {
        try {
          const blob = await outputBlob(t);
          meta.outputFile =
            'images/' +
            fileName({
              ...t,
              outputBlob: blob,
            });
          files.push({
            name: meta.outputFile,
            blob,
          });
        } catch (e) {
          errors.push(`${t.id}：${e.message}`);
          meta.outputFile = null;
        }
      }
      for (let i = 0; i < t.refs.length; i++)
        files.push({
          name: meta.references[i].file,
          blob: t.refs[i].blob,
        });
      if (t.mask)
        files.push({
          name: meta.maskFile,
          blob: t.mask.blob,
        });
      metadata.push(meta);
    }
    files.push({
      name: '创作记录.json',
      blob: new Blob(
        [
          JSON.stringify(
            {
              version: 3,
              exportedAt: new Date().toISOString(),
              tasks: metadata,
            },
            null,
            2,
          ),
        ],
        {
          type: 'application/json',
        },
      ),
    });
    files.push({
      name: '提示词.txt',
      blob: new Blob(
        [
          tasks
            .map(
              (t) =>
                `${taskTitle(t)}\n${t.effectivePrompt || effectivePrompt(t)}\n\n${taskMeta(t)}`,
            )
            .join('\n\n----------------\n\n'),
        ],
        {
          type: 'text/plain;charset=utf-8',
        },
      ),
    });
    if (errors.length)
      files.push({
        name: '未能下载的图片.txt',
        blob: new Blob([errors.join('\n')], {
          type: 'text/plain;charset=utf-8',
        }),
      });
    const zip = await makeZip(files);
    saveBlob(zip, `OpenLux-${new Date().toISOString().slice(0, 10)}-${tasks.length}张.zip`);
    notify(
      errors.length
        ? `导出完成，${errors.length} 张远程图片无法读取，详情已写入压缩包。`
        : '图片、提示词、参数与参考图已打包。',
    );
  } finally {
    exporting = false;
    updateBulk();
  }
}
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function encodeBackup(value) {
  if (value instanceof Blob)
    return {
      __openlux_blob: await blobToDataURL(value),
      type: value.type,
    };
  if (Array.isArray(value)) {
    const result = [];
    for (const v of value) result.push(await encodeBackup(v));
    return result;
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) result[k] = await encodeBackup(v);
    return result;
  }
  return value;
}
async function decodeBackup(value) {
  if (value && typeof value === 'object' && typeof value.__openlux_blob === 'string') {
    if (!/^data:image\/(png|jpeg|webp);base64,/i.test(value.__openlux_blob))
      throw new Error('备份中包含不支持的图片类型。');
    return (await fetch(value.__openlux_blob)).blob();
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const v of value) result.push(await decodeBackup(v));
    return result;
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype', 'key', 'apiKey', 'openlux_key'].includes(k))
        continue;
      result[k] = await decodeBackup(v);
    }
    return result;
  }
  return value;
}
async function exportBackup() {
  if (exporting) throw new Error('正在导出，请等待当前操作完成。');
  exporting = true;
  try {
    await flushDraft();
    notify('正在整理完整备份，图片较多时请稍候…');
    const encoded = await encodeBackup(structuredClone(rootSnapshot()));
    saveBlob(
      new Blob([JSON.stringify(encoded)], {
        type: 'application/json',
      }),
      `OpenLux-完整备份-${new Date().toISOString().slice(0, 10)}.json`,
    );
    notify('完整备份已导出，不包含 API Key。');
  } finally {
    exporting = false;
  }
}
async function exportUsage() {
  const rows = [
    ['时间', '项目', '模型', '状态', 'HTTP', '耗时秒', '币种', '成功估算费用', '用量JSON'],
    ...state.ledger.map((l) => [
      new Date(l.at).toISOString(),
      projectName(l.projectId),
      l.model,
      l.status,
      l.httpStatus || '',
      ((l.elapsedMs || 0) / 1000).toFixed(1),
      l.currency || '',
      l.estimatedCost ?? '',
      l.usage ? JSON.stringify(l.usage) : '',
    ]),
  ];
  const csv =
    '\ufeff' +
    rows
      .map((row) => row.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(','))
      .join('\r\n');
  saveBlob(
    new Blob([csv], {
      type: 'text/csv;charset=utf-8',
    }),
    'OpenLux-用量明细.csv',
  );
}
function mountFeaturesTransfers() {
  $('zipBtn').onclick = guard(exportSelected);
  $('backupInput').onchange = guard(async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 500 * 1024 * 1024) throw new Error('备份超过 500 MB，请分批管理素材。');
    let raw;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new Error('备份不是有效的 JSON 文件。');
    }
    if (
      raw.version !== 3 ||
      !Array.isArray(raw.tasks) ||
      raw.tasks.length > 10000 ||
      !Array.isArray(raw.projects) ||
      !Array.isArray(raw.presets) ||
      !Array.isArray(raw.assets) ||
      !Array.isArray(raw.ledger)
    )
      throw new Error('文件不是本工具的完整备份。');
    if (
      !(await askConfirm(
        '合并这份备份？',
        '新增的项目、素材和记录会加入本机；相同 ID 的现有记录保留。当前草稿与连接不会被覆盖。',
        '合并导入',
      ))
    )
      return;
    const restored = await decodeBackup(raw);
    restored.agentRuns = Array.isArray(restored.agentRuns) ? restored.agentRuns : [];
    const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
    for (const key of ['tasks', 'projects', 'presets', 'assets', 'ledger'])
      for (const item of restored[key])
        if (!item || !validId(item.id)) throw new Error('备份包含无效记录 ID。');
    for (const run of restored.agentRuns) {
      if (
        !validId(run?.id) ||
        typeof run.request !== 'string' ||
        !run.snapshot ||
        !Array.isArray(run.snapshot.refs)
      )
        throw new Error('备份中的 Agent 方案无效。');
      for (const ref of run.snapshot.refs)
        if (!validId(ref.id) || !(ref.blob instanceof Blob))
          throw new Error('Agent 参考素材无效。');
      run.stopped = true;
      recoverAgentSession(run, restored.tasks, true);
    }
    for (const t of restored.tasks) {
      if (
        typeof t.prompt !== 'string' ||
        !t.settings ||
        !Array.isArray(t.refs) ||
        !Object.keys(STATUS_NAMES).includes(t.status)
      )
        throw new Error('备份中的作品记录格式不完整。');
      parseBase(t.settings.base || DEFAULT_BASE);
      for (const r of t.refs)
        if (!validId(r.id) || !(r.blob instanceof Blob)) throw new Error('备份中的参考图无效。');
      if (t.status === 'queued' || t.status === 'retry_wait') {
        t.status = 'cancelled';
        t.error = '从备份导入的待提交任务，请确认后手动重新生成。';
      }
      normalizeTask(t);
    }
    for (const key of ['presets', 'assets'])
      for (const item of restored[key]) {
        if (!Array.isArray(item.refs)) throw new Error('备份素材格式无效。');
        for (const r of item.refs)
          if (!validId(r.id) || !(r.blob instanceof Blob)) throw new Error('备份素材图片无效。');
      }
    let added = 0;
    for (const key of ['projects', 'tasks', 'presets', 'assets', 'ledger', 'agentRuns']) {
      const ids = new Set(state[key].map((x) => x.id));
      for (const item of restored[key])
        if (!ids.has(item.id)) {
          state[key].push(item);
          ids.add(item.id);
          added++;
        }
    }
    renderProjects();
    render();
    await persist();
    renderLibrary();
    notify(`备份已合并，新增 ${added} 条记录。`);
  });
}
export {
  download,
  copyImageForPhotoshop,
  downloadPhotoshopPng,
  exportBackup,
  exportUsage,
  fileName,
  mountFeaturesTransfers,
  safeName,
  saveBlob,
};
