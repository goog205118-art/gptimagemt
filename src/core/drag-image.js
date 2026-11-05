import { escapeHTML } from './utils.js';

// Keep the image drag's native bitmap/file-content payload. Adding a synthetic
// File or DownloadURL here can replace it with a delayed virtual download on Windows.
export function writeImageDrag(dataTransfer, { id, src, name }) {
  if (!dataTransfer) return;
  dataTransfer.effectAllowed = 'copy';
  dataTransfer.setData('application/x-openlux-image', id);
  if (src && !dataTransfer.getData('text/uri-list')) dataTransfer.setData('text/uri-list', src);
  if (src && !dataTransfer.getData('text/html'))
    dataTransfer.setData('text/html', `<img src="${escapeHTML(src)}" alt="${escapeHTML(name)}">`);
}
