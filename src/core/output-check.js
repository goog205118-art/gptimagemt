import { ownImageBytes, decodeImageBlob } from './image-input.js';

export function compareOutput({ width, height, format, count = 1 }, expected) {
  const issues = [];
  const [w, h] = String(expected.size).split('x').map(Number);
  if (w && h && (w !== width || h !== height)) issues.push(`实际尺寸 ${width}×${height}，要求 ${w}×${h}。`);
  if (format !== expected.format) issues.push(`实际格式 ${format}，要求 ${expected.format}。`);
  if (count !== 1) issues.push(`单次请求实际返回 ${count} 张，预期 1 张；请核对额外结果和服务商用量。`);
  return issues;
}

export async function inspectOutput(blob, expected, count = 1) {
  try {
    const owned = await ownImageBytes(blob, '生成结果');
    const image = await decodeImageBlob(owned, '生成结果');
    try {
      const actual = { width: image.width, height: image.height, format: owned.type.split('/')[1], count, bytes: owned.size };
      return { checkedAt: Date.now(), actual, issues: compareOutput(actual, expected), visualStatus: 'unchecked' };
    } finally { image.close(); }
  } catch (e) {
    return { checkedAt: Date.now(), actual: null, issues: [e.message], visualStatus: 'unchecked' };
  }
}
