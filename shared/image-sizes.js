import { splitGptModel } from './model-ids.js';

// https://developers.openai.com/api/docs/guides/image-generation
// GPT-Image-2 constraints, checked 2026-11-24. Unknown aliases keep standard sizes.
export const STANDARD_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'];
export const FLEXIBLE_IMAGE_RULES = Object.freeze({
  step: 16, maxEdge: 3840, maxRatio: 3,
  minPixels: 655360, maxPixels: 8294400, experimentalPixels: 2560 * 1440,
});

export function imageSizeRules(model) {
  const { core } = splitGptModel(model);
  const flexible = /^gpt-image-(?:2(?:\.0)?|2\.5-(?:sunburst|flare))(?:-\d{4}-\d{2}-\d{2})?(?:-c)?$/.test(core);
  return { ...FLEXIBLE_IMAGE_RULES, flexible, sizes: [...STANDARD_IMAGE_SIZES] };
}

export function parseImageSize(size) {
  if (typeof size !== 'string' || !/^\d{1,5}x\d{1,5}$/.test(size)) return null;
  const [width, height] = size.split('x').map(Number);
  return { width, height };
}

export function imageSizeError(size, model) {
  if (size === 'auto') return '';
  const rules = typeof model === 'string' ? imageSizeRules(model) : model;
  const dimensions = parseImageSize(size);
  if (!dimensions) return '请填写完整的整数宽度和高度。';
  const { width, height } = dimensions;
  if (!rules?.flexible)
    return STANDARD_IMAGE_SIZES.includes(size) ? '' : '当前模型仅支持自动尺寸、1024×1024、1536×1024 或 1024×1536；请切换 GPT Image 2 / 2.5 使用自定义尺寸。';
  if (width <= 0 || height <= 0) return '宽度和高度必须大于 0。';
  if (width % rules.step || height % rules.step) return `宽度和高度都必须是 ${rules.step} 的整数倍。`;
  if (Math.max(width, height) > rules.maxEdge) return `任意一边不能超过 ${rules.maxEdge} 像素。`;
  if (Math.max(width, height) / Math.min(width, height) > rules.maxRatio) return '长边与短边的比例不能超过 3:1。';
  if (width * height < rules.minPixels) return '总像素不能少于 655,360，请增大尺寸。';
  if (width * height > rules.maxPixels) return '总像素不能超过 8,294,400，请缩小尺寸。';
  return '';
}

export function validGptSize(size, model) {
  return !imageSizeError(size, model);
}

export function experimentalImageSize(size, model) {
  const rules = typeof model === 'string' ? imageSizeRules(model) : model;
  const dimensions = parseImageSize(size);
  return !!rules?.flexible && !!dimensions && dimensions.width * dimensions.height > rules.experimentalPixels;
}

export function imageSizeRatio(size) {
  const dimensions = parseImageSize(size);
  if (!dimensions || !dimensions.width || !dimensions.height) return '';
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(dimensions.width, dimensions.height);
  return `${dimensions.width / divisor}:${dimensions.height / divisor}`;
}

// Pick the closest legal grid point; show the actual ratio before generation.
// All candidates pass the same validator used by the request builder.
export function sizeFromRatio(ratioWidth, ratioHeight, longEdge, model) {
  const rules = imageSizeRules(model);
  if (!rules.flexible) throw new Error('当前模型不支持自定义比例，请切换 GPT Image 2 / 2.5。');
  const values = [ratioWidth, ratioHeight, longEdge].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error('比例和目标长边必须填写大于 0 的数字。');
  const [a, b, edge] = values, ratio = a / b;
  if (ratio < 1 / rules.maxRatio || ratio > rules.maxRatio) throw new Error('自定义比例必须在 1:3 到 3:1 之间。');
  if (edge > rules.maxEdge) throw new Error(`目标长边不能超过 ${rules.maxEdge} 像素。`);
  let best, bestScore = Infinity;
  for (let width = rules.step; width <= rules.maxEdge; width += rules.step) {
    for (let height = rules.step; height <= rules.maxEdge; height += rules.step) {
      const pixels = width * height;
      if (pixels < rules.minPixels || pixels > rules.maxPixels || Math.max(width, height) / Math.min(width, height) > rules.maxRatio) continue;
      const score = 4 * Math.abs(Math.log(width / height / ratio)) + Math.abs(Math.log(Math.max(width, height) / edge));
      if (score < bestScore) { bestScore = score; best = `${width}x${height}`; }
    }
  }
  if (!best || !validGptSize(best, model)) throw new Error('该比例无法换算为当前模型支持的尺寸。');
  return best;
}
