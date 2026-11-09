import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { expandComposer, renderEditContext, scheduleDraft, setSelect } from './composer.js';
import { guard, setStatus, showDialog } from '../ui/dialogs.js';
import { MAX_FILE } from '../core/config.js';
import { safeName, saveBlob } from './transfers.js';
import { uid } from '../core/utils.js';
import { renderRefs } from './references.js';
let editor = {
  bitmap: null,
  source: null,
  mode: 'mask',
  strokes: [],
  baseSelection: null,
  eraser: false,
  drawing: false,
  current: null,
  panX: 0,
  panY: 0,
  drag: null,
  refId: null,
};
const canvasBlob = (canvas, type = 'image/png', quality = 0.92) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片导出失败，请缩小画布后重试。'))),
      type,
      quality,
    ),
  );
function newCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}
async function openEditor(mode = 'mask', session = null) {
  const ref = session?.ref || state.refs[0];
  const sourceMask = session ? session.mask : state.mask;
  if (!ref) throw new Error('请先添加参考图，或在作品卡片上选择局部修改。');
  const bitmap = await createImageBitmap(ref.blob);
  if (bitmap.width * bitmap.height > 40000000) {
    bitmap.close();
    throw new Error('这张图像素过大，请先缩小后编辑。');
  }
  editor.bitmap?.close();
  editor = {
    bitmap,
    source: ref.blob,
    mode,
    strokes: [],
    baseSelection: null,
    eraser: false,
    drawing: false,
    current: null,
    panX: 0,
    panY: 0,
    drag: null,
    refId: ref.id,
    session,
  };
  if (sourceMask?.assetId === ref.id && sourceMask.kind !== 'outpaint') {
    const old = await createImageBitmap(sourceMask.blob),
      selection = newCanvas(bitmap.width, bitmap.height),
      ctx = selection.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, selection.width, selection.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(old, 0, 0, selection.width, selection.height);
    ctx.globalCompositeOperation = 'source-over';
    old.close();
    editor.baseSelection = selection;
  }
  $('cropZoom').value = 1;
  $('expandScale').value = 1;
  $('eraserBtn').setAttribute('aria-pressed', 'false');
  $('expandAI').checked = true;
  $('editorRatio').disabled = !!session;
  $('editorCanvas').tabIndex = 0;
  $('editorCanvas').setAttribute('aria-label', mode === 'mask' ? '涂抹修改区域画布' : '裁切或扩图预览，方向键调整位置');
  $('maskKeepOutside').checked = sourceMask?.keepOutside !== false;
  setSelect('maskMode', sourceMask?.mode || 'auto');
  setSelect('outpaintPolicy', sourceMask?.outpaintPolicy || 'natural');
  $('outpaintIntent').value = sourceMask?.sceneIntent || '';
  if (session?.size) {
    const [w, h] = session.size.split('x').map(Number);
    if (w && h) setSelect('editorRatio', `${w}:${h}`);
  }
  $('outpaintPolicy').dispatchEvent(new Event('change'));
  showDialog('editorDlg');
  setEditorMode(mode);
}
function setEditorMode(mode) {
  editor.mode = mode;
  editor.panX = 0;
  editor.panY = 0;
  editor.drag = null;
  editor.drawing = false;
  document
    .querySelectorAll('[data-editor-mode]')
    .forEach((b) => { b.classList.toggle('outlined', b.dataset.editorMode === mode); b.disabled = !!editor.session && b.dataset.editorMode !== mode; });
  $('maskTools').hidden = mode !== 'mask';
  $('ratioTools').hidden = mode === 'mask';
  $('outpaintOptions').hidden = mode !== 'expand';
  $('gptMaskAdvice').hidden = mode !== 'mask';
  $('cropZoomLabel').hidden = mode !== 'crop';
  $('expandScaleLabel').hidden = mode !== 'expand';
  $('expandAIWrap').hidden = mode !== 'expand';
  $('editorHint').textContent =
    mode === 'mask'
      ? '涂抹需要修改的区域。可用橡皮擦除、撤销最后一笔；应用后再填写修改要求。勾选保留未涂抹区域后，结果会在本地与原图合成；涂抹边缘可适当留出过渡空间。'
      : mode === 'crop'
        ? '拖动画面调整裁切位置，缩放决定保留范围。本地裁切不调用生图接口。'
        : '拖动选择原图位置。可说明新区域的用途、结构与物件。取消 AI 补全时，只保留透明边缘。';
  $('applyEditor').textContent =
    mode === 'mask' ? '应用局部编辑' : mode === 'crop' ? (editor.session ? '确认范围并保存裁切版本' : '裁切后放入输入框') : '确认扩图布局';
  $('downloadLocalEditor').hidden = mode === 'mask';
  renderEditor();
}
function editorDimensions() {
  if (editor.mode === 'mask') {
    const factor = Math.min(1, 1000 / editor.bitmap.width, 1000 / editor.bitmap.height);
    return [
      Math.max(1, Math.round(editor.bitmap.width * factor)),
      Math.max(1, Math.round(editor.bitmap.height * factor)),
    ];
  }
  const [a, b] = $('editorRatio').value.split(':').map(Number),
    long = 1100;
  return a >= b ? [long, Math.round((long * b) / a)] : [Math.round((long * a) / b), long];
}
function selectionCanvas(width = editor.bitmap.width, height = editor.bitmap.height) {
  const canvas = newCanvas(width, height),
    ctx = canvas.getContext('2d');
  if (editor.baseSelection) ctx.drawImage(editor.baseSelection, 0, 0, width, height);
  for (const stroke of [...editor.strokes, ...(editor.current ? [editor.current] : [])]) {
    if (!stroke.points.length) continue;
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = stroke.width * canvas.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const first = stroke.points[0];
    ctx.beginPath();
    ctx.arc(first.x * canvas.width, first.y * canvas.height, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(first.x * canvas.width, first.y * canvas.height);
    for (const point of stroke.points.slice(1))
      ctx.lineTo(point.x * canvas.width, point.y * canvas.height);
    ctx.stroke();
  }
  return canvas;
}
function editorPlacement(width, height) {
  const bitmap = editor.bitmap;
  const scale =
    editor.mode === 'crop'
      ? Math.max(width / bitmap.width, height / bitmap.height) * Number($('cropZoom').value)
      : Math.min(width / bitmap.width, height / bitmap.height) * Number($('expandScale').value);
  const w = bitmap.width * scale,
    h = bitmap.height * scale;
  const maxX = Math.abs(width - w) / 2,
    maxY = Math.abs(height - h) / 2;
  editor.panX = Math.max(-maxX / width, Math.min(maxX / width, editor.panX));
  editor.panY = Math.max(-maxY / height, Math.min(maxY / height, editor.panY));
  if (editor.mode === 'expand') {
    const rw = Math.min(width, Math.round(w)),
      rh = Math.min(height, Math.round(h));
    return {
      x: Math.max(0, Math.min(width - rw, Math.round((width - w) / 2 + editor.panX * width))),
      y: Math.max(0, Math.min(height - rh, Math.round((height - h) / 2 + editor.panY * height))),
      w: rw,
      h: rh,
    };
  }
  return {
    x: (width - w) / 2 + editor.panX * width,
    y: (height - h) / 2 + editor.panY * height,
    w,
    h,
  };
}
let renderEditorFrame = 0;
function requestEditorRender() {
  if (!renderEditorFrame)
    renderEditorFrame = requestAnimationFrame(() => {
      renderEditorFrame = 0;
      renderEditor();
    });
}
function renderEditor() {
  if (!editor.bitmap) return;
  const canvas = $('editorCanvas'),
    [w, h] = editorDimensions();
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (editor.mode === 'mask') {
    ctx.drawImage(editor.bitmap, 0, 0, w, h);
    const overlay = selectionCanvas(w, h),
      color = overlay.getContext('2d');
    color.globalCompositeOperation = 'source-in';
    color.fillStyle = 'rgba(180,55,50,.4)';
    color.fillRect(0, 0, overlay.width, overlay.height);
    ctx.drawImage(overlay, 0, 0, w, h);
  } else {
    const p = editorPlacement(w, h);
    ctx.fillStyle = '#e6e6e6';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 24)
      for (let x = 0; x < w; x += 24)
        if ((Math.floor(x / 24) + Math.floor(y / 24)) % 2 === 0) {
          ctx.fillStyle = '#f5f5f5';
          ctx.fillRect(x, y, 24, 24);
        }
    ctx.drawImage(editor.bitmap, p.x, p.y, p.w, p.h);
  }
}
function pointerPoint(e) {
  const rect = $('editorCanvas').getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
  };
}
function finishStroke() {
  if (editor.current) {
    editor.strokes.push(editor.current);
    editor.current = null;
  }
  editor.drawing = false;
  editor.drag = null;
  renderEditor();
}
function ratioOutput() {
  if (editor.session?.size && editor.session.size !== 'auto') return editor.session.size.split('x').map(Number);
  const [a, b] = $('editorRatio').value.split(':').map(Number);
  if (a === b) return [1024, 1024];
  return a > b ? [1536, Math.round((1536 * b) / a)] : [Math.round((1536 * a) / b), 1536];
}
function localEditorCanvas() {
  const [w, h] = ratioOutput(),
    canvas = newCanvas(w, h),
    ctx = canvas.getContext('2d'),
    p = editorPlacement(w, h);
  ctx.drawImage(editor.bitmap, p.x, p.y, p.w, p.h);
  return {
    canvas,
    placement: p,
  };
}
async function applyEditor() {
  const session = editor.session;
  const ref = session ? { ...session.ref } : state.refs.find((r) => r.id === editor.refId);
  let resultMask = null, addition = '', resultSize = null, crop = null;
  if (!ref || (!session && state.refs[0]?.id !== ref.id))
    throw new Error('当前第一张参考图已变化，请重新打开编辑器。');
  $('applyEditor').disabled = true;
  try {
    if (editor.mode === 'mask') {
      const selected = selectionCanvas(),
        alpha = selected.getContext('2d').getImageData(0, 0, selected.width, selected.height).data;
      let painted = false;
      for (let i = 3; i < alpha.length; i += 4)
        if (alpha[i]) {
          painted = true;
          break;
        }
      if (!painted) {
        resultMask = null;
        setStatus('局部编辑区域已清除。');
      } else {
        const source = newCanvas(editor.bitmap.width, editor.bitmap.height);
        source.getContext('2d').drawImage(editor.bitmap, 0, 0);
        const mask = newCanvas(source.width, source.height),
          ctx = mask.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, mask.width, mask.height);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(selected, 0, 0);
        const [baseBlob, maskBlob] = await Promise.all([canvasBlob(source), canvasBlob(mask)]);
        if (baseBlob.size > MAX_FILE || maskBlob.size > 4 * 1024 * 1024)
          throw new Error('底图或蒙版过大，请先裁切或缩小图片。');
        ref.blob = baseBlob;
        ref.name = safeName(ref.name.replace(/\.[^.]+$/, '')) + '.png';
        ref.role = 'base';
        resultMask = {
          assetId: ref.id,
          blob: maskBlob,
          width: mask.width,
          height: mask.height,
          keepOutside: $('maskKeepOutside').checked,
          mode: $('maskMode').value,
        };
        setStatus('已附加局部编辑区域。填写修改要求后点击生成。');
      }
    } else {
      const originalSource = (session ? session.mask : state.mask)?.originalBlob || editor.source;
      const { canvas, placement } = localEditorCanvas(),
        blob = await canvasBlob(canvas, editor.mode === 'crop' && session?.format ? `image/${session.format}` : 'image/png');
      ref.blob = blob;
      ref.name =
        (editor.mode === 'crop' ? '裁切-' : '适配-') +
        safeName(ref.name.replace(/\.[^.]+$/, '')) +
        (blob.type === 'image/jpeg' ? '.jpg' : blob.type === 'image/webp' ? '.webp' : '.png');
      ref.role = 'base';
      resultMask = null;
      resultSize = canvas.width + 'x' + canvas.height;
      if (editor.mode === 'crop') crop = { placement, width: canvas.width, height: canvas.height, sourceWidth: editor.bitmap.width, sourceHeight: editor.bitmap.height };
      if (
        editor.mode === 'expand' &&
        $('expandAI').checked &&
        (placement.x > 0 ||
          placement.y > 0 ||
          placement.w < canvas.width ||
          placement.h < canvas.height)
      ) {
        const mask = newCanvas(canvas.width, canvas.height),
          ctx = mask.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(
          Math.max(0, Math.round(placement.x)),
          Math.max(0, Math.round(placement.y)),
          Math.min(canvas.width, Math.round(placement.w)),
          Math.min(canvas.height, Math.round(placement.h)),
        );
        resultMask = {
          assetId: ref.id,
          blob: await canvasBlob(mask),
          width: mask.width,
          height: mask.height,
          kind: 'outpaint',
          originalBlob: originalSource,
          mode: 'auto',
          keepOutside: true,
          outpaintPolicy: $('outpaintPolicy').value,
          sceneIntent: $('outpaintIntent').value.trim(),
          placement: {
            x: placement.x,
            y: placement.y,
            width: placement.w,
            height: placement.h,
          },
        };
        addition =
          '合理拓展原场景：先推断画面外真实空间和物体结构，再补全透视、光线与材质一致的新区域；避免拉伸、复制或刻意延长现有物件。';
      }
      setStatus(
        editor.mode === 'crop'
          ? '本地裁切完成，已作为当前底图。'
          : '画布比例已适配，提交生成可继续修改。',
      );
    }
    ref.id = uid();
    ref.sourceAssetId = editor.refId;
    ref.userRole = 'base';
    if (resultMask) resultMask.assetId = ref.id;
    if (session) {
      await session.onApply({ ref, mask: resultMask, size: resultSize, addition, crop });
      $('editorDlg').close();
      session.onComplete?.();
      return;
    }
    state.mask = resultMask;
    if (resultSize) setSelect('size', resultSize);
    if (addition) $('prompt').value = [$('prompt').value.trim(), addition].filter(Boolean).join('\n');
    renderRefs();
    renderEditContext();
    scheduleDraft();
    $('editorDlg').close();
    expandComposer();
    $('prompt').focus();
  } finally {
    $('applyEditor').disabled = false;
  }
}
function mountFeaturesEditor() {
  $('editMaskBtn').onclick = guard(() => openEditor('mask'));
  $('localEditorBtn').onclick = guard(() => openEditor('crop'));
  document
    .querySelectorAll('[data-editor-mode]')
    .forEach((b) => (b.onclick = () => setEditorMode(b.dataset.editorMode)));
  for (const id of ['editorRatio', 'cropZoom', 'expandScale'])
    $(id).oninput = () => {
      renderEditor();
    };
  $('eraserBtn').onclick = () => {
    editor.eraser = !editor.eraser;
    $('eraserBtn').setAttribute('aria-pressed', String(editor.eraser));
    $('eraserBtn').classList.toggle('outlined', editor.eraser);
  };
  $('undoMask').onclick = () => {
    editor.strokes.pop();
    renderEditor();
  };
  $('clearMask').onclick = () => {
    editor.strokes = [];
    editor.baseSelection = null;
    renderEditor();
  };
  $('editorCanvas').onpointerdown = (e) => {
    e.preventDefault();
    $('editorCanvas').setPointerCapture(e.pointerId);
    const point = pointerPoint(e);
    if (editor.mode === 'mask') {
      editor.drawing = true;
      editor.current = {
        erase: editor.eraser,
        width: Number($('brushSize').value) / $('editorCanvas').width,
        points: [point],
      };
    } else
      editor.drag = {
        point,
        x: editor.panX,
        y: editor.panY,
      };
    requestEditorRender();
  };
  $('editorCanvas').onpointermove = (e) => {
    if (editor.drawing && editor.current) {
      editor.current.points.push(pointerPoint(e));
      requestEditorRender();
    } else if (editor.drag) {
      const point = pointerPoint(e);
      editor.panX = editor.drag.x + point.x - editor.drag.point.x;
      editor.panY = editor.drag.y + point.y - editor.drag.point.y;
      requestEditorRender();
    }
  };
  $('editorCanvas').onpointerup = $('editorCanvas').onpointercancel = finishStroke;
  $('editorCanvas').onkeydown = (e) => {
    if (editor.mode === 'mask' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.05 : 0.01;
    editor.panX += e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    editor.panY += e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    renderEditor();
  };
  $('applyEditor').onclick = guard(applyEditor);
  $('downloadLocalEditor').onclick = guard(async () => {
    const { canvas } = localEditorCanvas();
    saveBlob(
      await canvasBlob(canvas),
      `OpenLux-${editor.mode === 'crop' ? '裁切' : '画布适配'}-${$('editorRatio').value.replace(':', 'x')}.png`,
    );
  });
  $('editorDlg').addEventListener('close', () => {
    editor.bitmap?.close();
    editor.bitmap = null;
    editor.baseSelection = null;
    editor.source = null;
    editor.strokes = [];
  });
  $('outpaintPolicy').addEventListener('change', () => {
    $('outpaintPolicyHelp').textContent =
      $('outpaintPolicy').value === 'natural'
        ? '自然重构使用完整生成画面，优先保持空间、光色与透视连续；原图细节可能轻微变化。'
        : '原图优先保留中心细节，对齐后匹配色调并柔化边缘；若无法精确对齐则保留完整生成画面。';
  });
}
export { canvasBlob, mountFeaturesEditor, newCanvas, openEditor };
