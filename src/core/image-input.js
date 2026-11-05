import { MAX_FILE } from './config.js';

function detectedType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71 &&
    bytes[4] === 13 &&
    bytes[5] === 10 &&
    bytes[6] === 26 &&
    bytes[7] === 10
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return '';
}

// Blob([file]) and file.slice() can keep the underlying file reference. Read all
// bytes first so a web drag's temporary file can disappear without losing data.
export async function ownImageBytes(file, label = '参考图') {
  if (!(file instanceof Blob) || !file.size)
    throw new Error(`${label}没有可读取的图片数据，请重新添加。`);
  if (file.size > MAX_FILE) throw new Error(`${label}超过 25 MB，请缩小后再添加。`);
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error(`${label}的原始文件已失效或无法读取。请从网页重新拖入，或下载后通过“＋”添加。`);
  }
  if (buffer.byteLength !== file.size) throw new Error(`${label}读取不完整，请重新添加。`);
  const type = detectedType(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 12)));
  if (!type)
    throw new Error(`${label}的实际数据不是 PNG、JPEG 或 WebP；请下载为这些格式后再添加。`);
  return new Blob([buffer], { type });
}

export async function decodeImageBlob(blob, label = '参考图') {
  try {
    return await createImageBitmap(blob);
  } catch {
    // HTMLImageElement has a separate decoding path on some browser builds.
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error();
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => {
          URL.revokeObjectURL(url);
          image.removeAttribute('src');
        },
      };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error(
        `${label}无法解码。请重新添加该图片；若缩略图仍可显示，可先下载再通过“＋”选择原图。`,
      );
    }
  }
}
