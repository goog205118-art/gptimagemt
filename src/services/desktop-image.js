import { decodeImageBlob } from '../core/image-input.js';

const converted = new WeakMap();
export function photoshopPng(blob) {
  if (!(blob instanceof Blob)) return Promise.reject(new Error('原图数据尚不可用，请先下载检查。'));
  if (blob.type === 'image/png') return Promise.resolve(blob);
  if (!converted.has(blob)) {
    const pending = (async () => {
      const image = await decodeImageBlob(blob, '导出图片');
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器无法创建图片导出画布。');
        context.drawImage(image.source || image, 0, 0);
        return await new Promise((resolve, reject) =>
          canvas.toBlob(
            (output) =>
              output ? resolve(output) : reject(new Error('PNG 导出失败，请下载原图。')),
            'image/png',
          ),
        );
      } finally {
        image.close();
      }
    })();
    converted.set(blob, pending);
    pending.catch(() => converted.delete(blob));
  }
  return converted.get(blob);
}
