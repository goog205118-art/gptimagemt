import test from 'node:test';
import assert from 'node:assert/strict';
import { writeImageDrag } from '../src/core/drag-image.js';
import { photoshopPng } from '../src/services/desktop-image.js';

test('native image payload survives without synthetic files or DownloadURL replacing it', () => {
  const native = new Map([
    ['text/html', 'native image payload'],
    ['text/uri-list', 'blob:https://example.test/image'],
  ]);
  const transfer = {
    effectAllowed: 'all',
    getData: (key) => native.get(key) || '',
    setData: (key, value) => native.set(key, value),
    items: {
      add() {
        throw new Error('Must not replace native image file contents');
      },
    },
  };
  writeImageDrag(transfer, {
    id: 'task1',
    src: 'blob:https://example.test/other',
    name: 'poster.png',
  });
  assert.equal(native.get('application/x-openlux-image'), 'task1');
  assert.equal(native.get('text/html'), 'native image payload');
  assert.equal(native.get('text/uri-list'), 'blob:https://example.test/image');
  assert.equal(native.has('DownloadURL'), false);
  assert.equal(transfer.effectAllowed, 'copy');
});
test('fallback HTML escapes the filename and keeps app-local image identity', () => {
  const values = new Map();
  writeImageDrag(
    { getData: (key) => values.get(key) || '', setData: (key, value) => values.set(key, value) },
    { id: 'reference1', src: 'blob:https://example.test/image', name: 'a"<b>.png' },
  );
  assert.equal(values.get('application/x-openlux-image'), 'reference1');
  assert.ok(values.get('text/html').includes('a&quot;&lt;b&gt;.png'));
});
test('PNG transfer preserves original bytes without rendering or recompression', async () => {
  const blob = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
    type: 'image/png',
  });
  assert.equal(await photoshopPng(blob), blob);
  await assert.rejects(() => photoshopPng(null), /原图数据尚不可用/);
});
