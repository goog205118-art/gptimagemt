import { state, taskById } from '../core/state.js';
import { canvasBlob, newCanvas } from './editor.js';
import { uid } from '../core/utils.js';
import { copyRefs } from '../core/assets.js';
import { encodeGptOutput, validateGptMask } from '../services/images.js';
import { persist } from '../core/storage.js';
import { render } from './gallery.js';
import { $ } from '../core/dom.js';
import { openDetail } from './detail.js';
import { notify } from '../ui/dialogs.js';
function isOutpaintTask(t) {
  return (
    !!t.mask &&
    (t.mask.kind === 'outpaint' ||
      (/^适配-/.test(t.refs[0]?.name || '') &&
        /补全画布空白|扩展画布/.test(t.prompt || '') &&
        t.maskValidation?.outerSelection &&
        t.maskValidation?.rectangularPreserved))
  );
}
function outpaintPlacement(t) {
  const p = t.mask?.placement || t.maskValidation?.preservedBounds;
  return p && p.width > 0 && p.height > 0 ? p : null;
}
function outpaintPolicy(t) {
  return t.mask?.outpaintPolicy === 'preserve' ? 'preserve' : 'natural';
}
function outpaintPrompt(t, p, v) {
  const original = t.outpaintSourceIndex
      ? `图${t.outpaintSourceIndex}是完整原图，供理解真实场景；`
      : '中央照片是原始场景；',
    root = taskById(t.rootId) || taskById(t.parentId),
    context =
      root?.prompt && !/补全画布空白/.test(root.prompt)
        ? `场景背景：${root.prompt.slice(0, 180)}。`
        : '',
    intent = t.mask.sceneIntent ? `新区域要求：${t.mask.sceneIntent}。` : '';
  return `\n扩图任务：图1是${v.width}x${v.height}目标画布，灰色区域是待生成留白，不是实体。${original}${context}原图位置x=${p.x},y=${p.y},width=${p.width},height=${p.height}像素。先推断画面外真实结构、物体完整形态、透视消失点、遮挡与光线，再生成合理的新可见区域。${intent}禁止拉伸边缘、复制物件、无限延长家具、平铺或拼贴；不要保留灰边。保持主体尺度和位置，${outpaintPolicy(t) === 'natural' ? '允许协调边界纹理和光色，以一张连续自然的完整照片输出。' : '尽量保持原图内部细节，边界需要有自然过渡。'}`;
}
async function outpaintGuideBlob(t, blob) {
  const p = outpaintPlacement(t);
  if (!p) return blob;
  const image = await createImageBitmap(blob);
  try {
    const w = image.width,
      h = image.height,
      c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#b8b8b8';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0);
    t.outpaintTransport = {
      guide: 'neutral-layout',
      sourceRefIndex: t.outpaintSourceIndex,
      placement: {
        ...p,
      },
      width: w,
      height: h,
    };
    return await canvasBlob(c);
  } finally {
    image.close();
  }
}
async function outpaintOriginalBlob(t) {
  if (t.mask.originalBlob instanceof Blob) return t.mask.originalBlob;
  const image = await createImageBitmap(t.refs[0].blob);
  try {
    const p = outpaintPlacement(t),
      c = newCanvas(p.width, p.height);
    c.getContext('2d').drawImage(image, p.x, p.y, p.width, p.height, 0, 0, p.width, p.height);
    return await canvasBlob(c);
  } finally {
    image.close();
  }
}
function outpaintAlignment(source, edited, alpha, w, h) {
  const stride = Math.max(1, Math.floor(Math.max(w, h) / 240));
  let count = 0,
    error = 0,
    dot = 0,
    aa = 0,
    bb = 0,
    edgeCount = 0;
  const grey = (data, i) => data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
  for (let y = stride; y < h - stride; y += stride)
    for (let x = stride; x < w - stride; x += stride) {
      const i = (y * w + x) * 4;
      if (alpha[i + 3] < 254 || source[i + 3] < 254) continue;
      count++;
      error +=
        (Math.abs(source[i] - edited[i]) +
          Math.abs(source[i + 1] - edited[i + 1]) +
          Math.abs(source[i + 2] - edited[i + 2])) /
        3;
      const right = i + stride * 4,
        down = i + w * stride * 4;
      if (alpha[right + 3] < 254 || alpha[down + 3] < 254) continue;
      const ax = grey(source, right) - grey(source, i),
        ay = grey(source, down) - grey(source, i),
        bx = grey(edited, right) - grey(edited, i),
        by = grey(edited, down) - grey(edited, i);
      dot += ax * bx + ay * by;
      aa += ax * ax + ay * ay;
      bb += bx * bx + by * by;
      edgeCount++;
    }
  const meanError = count ? error / count : 255,
    edgeAgreement = aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0;
  return {
    aligned: count >= 16 && (meanError <= 3 || (meanError <= 22 && edgeAgreement >= 0.97)),
    meanError,
    edgeAgreement,
    samples: count,
    edgeSamples: edgeCount,
  };
}
function matchOutpaintTone(source, edited, alpha, w, h) {
  const step = Math.max(1, Math.floor(Math.max(w, h) / 160)),
    sum = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (alpha[i + 3] < 254 || source[i + 3] < 254 || edited[i + 3] < 254) continue;
      for (let c = 0; c < 3; c++) sum[c] += source[i + c] - edited[i + c];
      n++;
    }
  const offset = sum.map((v) => (n ? Math.max(-18, Math.min(18, v / n)) : 0));
  for (let i = 0; i < edited.length; i += 4)
    for (let c = 0; c < 3; c++)
      edited[i + c] = Math.max(0, Math.min(255, edited[i + c] + offset[c]));
  return offset;
}
async function finishOutpaint(t, source, edited, alpha, w, h, ratioMismatch) {
  const canvas = newCanvas(w, h),
    ctx = canvas.getContext('2d'),
    alignment = outpaintAlignment(source.data, edited.data, alpha, w, h),
    policy = outpaintPolicy(t);
  let preserved = false,
    tone = null;
  if (policy === 'preserve' && !ratioMismatch) {
    const candidate = new Uint8ClampedArray(edited.data);
    tone = matchOutpaintTone(source.data, candidate, alpha, w, h);
    const adjusted = outpaintAlignment(source.data, candidate, alpha, w, h);
    if (adjusted.aligned) {
      const p = outpaintPlacement(t),
        band = Math.max(12, Math.min(48, Math.round(Math.min(p.width, p.height) * 0.035)));
      edited.data.set(candidate);
      for (let y = p.y; y < p.y + p.height; y++)
        for (let x = p.x; x < p.x + p.width; x++) {
          const i = (y * w + x) * 4;
          if (alpha[i + 3] < 254) continue;
          const d = Math.min(x - p.x, p.x + p.width - 1 - x, y - p.y, p.y + p.height - 1 - y),
            u = Math.max(0, Math.min(1, d / band)),
            weight = u * u * (3 - 2 * u);
          for (let c = 0; c < 4; c++)
            edited.data[i + c] = Math.round(
              edited.data[i + c] * (1 - weight) + source.data[i + c] * weight,
            );
        }
      preserved = true;
      t.maskReport = {
        kind: 'outpaint',
        policy,
        outsidePreserved: false,
        corePreserved: true,
        featherPixels: band,
        alignment: adjusted,
        toneOffset: tone,
        width: w,
        height: h,
      };
    } else t.resultWarning = '原图与模型结果未精确对齐，已使用完整生成画面，避免重影与接缝。';
  }
  if (!preserved)
    t.maskReport = {
      kind: 'outpaint',
      policy: 'natural',
      outsidePreserved: false,
      corePreserved: false,
      alignment,
      width: w,
      height: h,
      ratioMismatch,
    };
  if (ratioMismatch)
    t.resultWarning = '渠道返回比例与目标不同，已等比裁切；使用完整画面，不再叠回原图。';
  ctx.putImageData(edited, 0, 0);
  return await canvasBlob(canvas);
}
async function reblendOutpaint(t) {
  if (!t.rawOutputBlob || !t.mask || !t.refs?.length)
    throw new Error('这张记录没有可重新融合的模型原始结果。');
  const copy = {
    ...t,
    id: uid(),
    parentId: t.id,
    rootId: t.rootId || t.id,
    refs: copyRefs(t.refs),
    mask: {
      ...t.mask,
      outpaintPolicy: 'natural',
    },
    settings: {
      ...t.settings,
    },
    name: (t.name || '扩图') + ' · 自然融合',
    createdAt: Date.now(),
    finishedAt: Date.now(),
    startedAt: null,
    attempts: 0,
    usage: null,
    priceEstimate: 0,
    pricePerImage: null,
    postprocessOnly: true,
    resultWarning: '',
    maskReport: null,
  };
  copy.maskValidation = await validateGptMask(copy);
  if (!isOutpaintTask(copy)) throw new Error('这条记录不是扩图任务。');
  copy.outputBlob = await encodeGptOutput(copy, copy.rawOutputBlob);
  copy.status = 'success';
  state.tasks.unshift(copy);
  await persist();
  render();
  if ($('detailDlg').open) openDetail(copy.id);
  notify('已生成新的自然融合版本，没有调用生图接口。');
}
export {
  finishOutpaint,
  isOutpaintTask,
  outpaintGuideBlob,
  outpaintOriginalBlob,
  outpaintPlacement,
  outpaintPrompt,
  reblendOutpaint,
};
