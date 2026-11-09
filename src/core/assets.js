import { refURLs, runtimeImages, state, taskById } from './state.js';
function validSrc(src) {
  return (
    typeof src === 'string' &&
    (/^data:image\/(png|jpeg|webp);base64,/i.test(src) || /^https?:\/\//i.test(src))
  );
}
function referenceURL(ref) {
  if (!refURLs.has(ref.id)) refURLs.set(ref.id, URL.createObjectURL(ref.blob));
  return refURLs.get(ref.id);
}
function imageURL(t) {
  if (t.outputBlob) {
    if (!runtimeImages.has(t.id)) runtimeImages.set(t.id, URL.createObjectURL(t.outputBlob));
    return runtimeImages.get(t.id);
  }
  return validSrc(t.src) ? t.src : '';
}
function pruneURLs() {
  const refs = [
    ...state.refs,
    ...state.tasks.flatMap((t) => t.refs || []),
    ...state.presets.flatMap((p) => p.refs || []),
    ...state.assets.flatMap((p) => p.refs || []),
    ...state.agentRuns.flatMap((run) => run.snapshot?.refs || []),
  ];
  const used = new Set(refs.map((r) => r.id));
  for (const [id, url] of refURLs)
    if (!used.has(id)) {
      URL.revokeObjectURL(url);
      refURLs.delete(id);
    }
  for (const [id, url] of runtimeImages)
    if (!taskById(id)?.outputBlob) {
      URL.revokeObjectURL(url);
      runtimeImages.delete(id);
    }
}
function copyRefs(refs) {
  return (refs || []).map((r) => ({
    ...r,
  }));
}
function extension(blob) {
  return blob?.type === 'image/jpeg' ? 'jpg' : blob?.type === 'image/webp' ? 'webp' : 'png';
}
async function fetchImage(src, signal) {
  if (!validSrc(src)) throw new Error('图片地址无效，请下载后手动添加。');
  try {
    const response = await fetch(src, {
      signal: signal || AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error();
    const raw = await response.blob(),
      b = new Uint8Array(await raw.slice(0, 12).arrayBuffer());
    const type =
      b[0] === 137 && b[1] === 80
        ? 'image/png'
        : b[0] === 255 && b[1] === 216
          ? 'image/jpeg'
          : String.fromCharCode(...b.slice(0, 4)) === 'RIFF'
            ? 'image/webp'
            : '';
    if (!type) throw new Error();
    return new Blob([raw], {
      type,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error('无法读取图片：链接可能过期或不允许跨域。请下载后再拖入。');
  }
}
async function outputBlob(t) {
  return t.outputBlob || (await fetchImage(t.src));
}
export { copyRefs, extension, fetchImage, imageURL, outputBlob, pruneURLs, referenceURL, validSrc };
