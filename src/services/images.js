import { gptProfile, isOpenLuxBase, validateGptTask } from './models.js';
import { effectivePrompt } from '../features/jobs.js';
import {
  finishOutpaint,
  isOutpaintTask,
  outpaintGuideBlob,
  outpaintOriginalBlob,
  outpaintPlacement,
  outpaintPrompt,
} from '../features/outpaint.js';
import { state } from '../core/state.js';
import { assertSingleImagePrompt } from '../../shared/agent-variants.js';
async function validateGptMask(t) {
  if (!t.mask) return null;
  if (!t.refs[0] || t.mask.assetId !== t.refs[0].id)
    throw new Error('蒙版必须对应第一张底图，请重新涂抹。');
  if (!(t.mask.blob instanceof Blob) || t.mask.blob.size > 4 * 1024 * 1024)
    throw new Error('蒙版须为 4 MB 以内的 PNG。');
  const [image, mask] = await Promise.all([
    createImageBitmap(t.refs[0].blob),
    createImageBitmap(t.mask.blob),
  ]);
  try {
    if (image.width !== mask.width || image.height !== mask.height)
      throw new Error('蒙版与底图像素尺寸不一致，请重新涂抹。');
    const canvas = document.createElement('canvas');
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(mask, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let selected = 0,
      minX = canvas.width,
      minY = canvas.height,
      maxX = 0,
      maxY = 0,
      opaque = 0,
      left = canvas.width,
      top = canvas.height,
      right = 0,
      bottom = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      const n = (i - 3) / 4,
        x = n % canvas.width,
        y = Math.floor(n / canvas.width);
      if (pixels[i] < 255) {
        selected++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      } else {
        opaque++;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    if (!selected) throw new Error('蒙版没有透明选区。请涂抹要修改的区域，再应用局部编辑。');
    const preservedBounds = opaque
      ? {
          x: left,
          y: top,
          width: right - left + 1,
          height: bottom - top + 1,
        }
      : null;
    return {
      width: image.width,
      height: image.height,
      selectedPixels: selected,
      bounds: {
        left: minX / image.width,
        top: minY / image.height,
        right: (maxX + 1) / image.width,
        bottom: (maxY + 1) / image.height,
      },
      preservedBounds,
      rectangularPreserved:
        !!preservedBounds && opaque === preservedBounds.width * preservedBounds.height,
      outerSelection: [
        3,
        (canvas.width - 1) * 4 + 3,
        (canvas.height - 1) * canvas.width * 4 + 3,
        pixels.length - 1,
      ].every((i) => pixels[i] === 0),
    };
  } finally {
    image.close();
    mask.close();
  }
}
function resolvedGptMaskMode(t) {
  if (!t.mask) return null;
  if (['native', 'guided'].includes(t.mask.mode)) return t.mask.mode;
  const p = gptProfile(t.settings.model + t.settings.route);
  return isOpenLuxBase(t.settings.base) && (p.v2 || p.v25) ? 'guided' : 'native';
}
function gptRequestPrompt(t) {
  let prompt = t.effectivePrompt || effectivePrompt(t);
  if (isOutpaintTask(t)) {
    const p = outpaintPlacement(t),
      v = t.maskValidation;
    if (!p || p.x < 0 || p.y < 0 || p.x + p.width > v.width || p.y + p.height > v.height)
      throw new Error('扩图位置数据已失效，请重新打开扩展画布并应用。');
    prompt = prompt.replace('\n\n仅修改蒙版透明区域，保持其余内容尽量不变。', '');
    return prompt + outpaintPrompt(t, p, v);
  }
  if (resolvedGptMaskMode(t) === 'guided' && t.maskValidation?.bounds) {
    const b = t.maskValidation.bounds,
      x = (b.left + b.right) / 2,
      y = (b.top + b.bottom) / 2,
      where =
        (y < 0.4 ? 'upper ' : y > 0.6 ? 'lower ' : 'middle ') +
        (x < 0.4 ? 'left' : x > 0.6 ? 'right' : 'center');
    prompt = prompt.replace('\n\n仅修改蒙版透明区域，保持其余内容尽量不变。', '');
    prompt += `\nEdit only the ${where} region of image 1: x=${Math.round(b.left * 100)}–${Math.round(b.right * 100)}%, y=${Math.round(b.top * 100)}–${Math.round(b.bottom * 100)}%. Apply the requested change there; preserve all other objects, positions and colors.`;
  }
  return prompt;
}
async function normalizedGptMaskBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const color = pixels.data[i + 3] ? 255 : 0;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = color;
    }
    ctx.putImageData(pixels, 0, 0);
    return await new Promise((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('蒙版标准化失败'))), 'image/png'),
    );
  } finally {
    bitmap.close();
  }
}
async function prepareGptRequest(t, formatFieldOverride = null) {
  const p = validateGptTask(t);
  if (t.mask) t.maskValidation = await validateGptMask(t);
  const s = t.settings,
    openlux = isOpenLuxBase(s.base);
  t.outpaintSourceIndex = isOutpaintTask(t) && t.refs.length < p.maxRefs ? t.refs.length + 1 : null;
  const params = {
    model: s.model + s.route,
    prompt: gptRequestPrompt(t),
    n: 1,
    size: s.size,
    quality: s.quality,
  };
  if (t.agentRunId || t.variant || t.variantCount > 1 || t.variantPromptMode === 'complete') assertSingleImagePrompt(params.prompt);
  if (p.v2 || p.v25) params.response_format = 'b64_json';
  if (params.prompt.length > p.maxPrompt)
    throw new Error(
      `加入选区说明后提示词为 ${params.prompt.length} 字符，当前模型限制 ${p.maxPrompt}，请缩短修改要求或参考说明。`,
    );
  t.maskTransport = resolvedGptMaskMode(t);
  const transport = state.prefs.gptTransport?.[s.base + '|' + params.model],
    field =
      formatFieldOverride ||
      transport?.formatField ||
      (openlux && p.v2 ? 'format' : 'output_format');
  params[field] = t.mask && t.mask.keepOutside !== false ? 'png' : s.format || 'png';
  if (s.background && s.background !== 'auto') params.background = s.background;
  if (!openlux && s.format && s.format !== 'png') params.output_compression = s.compression ?? 90;
  if (t.refs.length && p.fidelity) params.input_fidelity = p.fidelity;
  let body,
    path,
    headers = {};
  if (t.refs.length) {
    body = new FormData();
    for (const [k, v] of Object.entries(params)) body.append(k, String(v));
    for (const [i, ref] of t.refs.entries())
      body.append(
        'image',
        i === 0 && isOutpaintTask(t) && t.maskTransport === 'guided'
          ? await outpaintGuideBlob(t, ref.blob)
          : ref.blob,
        ref.name,
      );
    if (t.outpaintSourceIndex)
      body.append('image', await outpaintOriginalBlob(t), 'source-original.png');
    if (t.mask && t.maskTransport === 'native')
      body.append('mask', await normalizedGptMaskBlob(t.mask.blob), 'mask.png');
    path = '/images/edits';
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(params);
    path = '/images/generations';
  }
  return {
    body,
    path,
    headers,
    profile: p,
    params,
    formatField: field,
  };
}
function gptFormatCorrection(status, payload, prepared) {
  if (status !== 400) return null;
  const message = String(payload?.error?.message || payload?.message || '');
  if (!/unknown parameter|unrecognized.*parameter|unsupported.*parameter/i.test(message))
    return null;
  const field = prepared.formatField;
  if (!message.includes("'" + field + "'") && !message.includes('"' + field + '"')) return null;
  return field === 'format' ? 'output_format' : 'format';
}
async function protectGptMaskOutside(t, generated) {
  if (!t.mask || t.mask.keepOutside === false) return generated;
  const [original, result, mask] = await Promise.all([
    createImageBitmap(t.refs[0].blob),
    createImageBitmap(generated),
    createImageBitmap(t.mask.blob),
  ]);
  try {
    const w = original.width,
      h = original.height,
      canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(original, 0, 0);
    const source = ctx.getImageData(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    const outpaint = isOutpaintTask(t),
      ratioMismatch = outpaint && Math.abs(result.width / result.height - w / h) / (w / h) > 0.015;
    if (ratioMismatch) {
      const scale = Math.max(w / result.width, h / result.height);
      ctx.drawImage(
        result,
        (w - result.width * scale) / 2,
        (h - result.height * scale) / 2,
        result.width * scale,
        result.height * scale,
      );
    } else ctx.drawImage(result, 0, 0, w, h);
    const edited = ctx.getImageData(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(mask, 0, 0, w, h);
    const alpha = ctx.getImageData(0, 0, w, h).data;
    let pixels = 0,
      changed = 0;
    if (outpaint) return await finishOutpaint(t, source, edited, alpha, w, h, ratioMismatch);
    const alignment = null;
    for (let i = 0; i < source.data.length; i += 4) {
      const amount = 1 - alpha[i + 3] / 255;
      if (amount > 0) {
        pixels++;
        if (
          Math.abs(source.data[i] - edited.data[i]) +
            Math.abs(source.data[i + 1] - edited.data[i + 1]) +
            Math.abs(source.data[i + 2] - edited.data[i + 2]) >
          36
        )
          changed++;
      }
      for (let c = 0; c < 4; c++)
        source.data[i + c] = Math.round(
          source.data[i + c] * (1 - amount) + edited.data[i + c] * amount,
        );
    }
    ctx.putImageData(source, 0, 0);
    t.maskReport = {
      outsidePreserved: true,
      kind: outpaint ? 'outpaint' : 'mask',
      alignment,
      width: w,
      height: h,
      resizedOutput: result.width !== w || result.height !== h,
      changedFraction: pixels ? changed / pixels : 0,
    };
    if (pixels && changed / pixels < 0.01)
      t.resultWarning = '选区变化很小：可能是当前路线未遵循蒙版，请检查选区或尝试 2.5 Sunburst。';
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('蒙版合成失败，请重试本地处理。'))),
        'image/png',
      ),
    );
  } finally {
    original.close();
    result.close();
    mask.close();
  }
}
async function encodeGptOutput(t, blob) {
  if (t.mask && t.mask.keepOutside !== false) return protectGptMaskOutside(t, blob);
  if (!isOpenLuxBase(t.settings.base) || !['jpeg', 'webp'].includes(t.settings.format)) return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext('2d').drawImage(bitmap, 0, 0);
    return await new Promise((resolve) =>
      c.toBlob(
        (b) => resolve(b || blob),
        'image/' + t.settings.format,
        (t.settings.compression ?? 90) / 100,
      ),
    );
  } finally {
    bitmap.close();
  }
}
export { encodeGptOutput, gptFormatCorrection, prepareGptRequest, validateGptMask };
