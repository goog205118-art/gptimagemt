import test from 'node:test';
import assert from 'node:assert/strict';
import { ownImageBytes } from '../src/core/image-input.js';
import { storageFailureMessage } from '../src/core/storage-error.js';

const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
test('imports copy actual bytes, infer MIME from content and preserve every byte', async () => {
  const source = new Blob([bytes], { type: 'image/jpeg' });
  const owned = await ownImageBytes(source);
  assert.notEqual(owned, source);
  assert.equal(owned.type, 'image/png');
  assert.deepEqual(new Uint8Array(await owned.arrayBuffer()), bytes);
});
test('an owned reference survives expiration of its source file', async () => {
  let expired = false;
  class TemporaryFile extends Blob {
    async arrayBuffer() {
      if (expired) throw new DOMException('expired', 'NotReadableError');
      return super.arrayBuffer();
    }
  }
  const source = new TemporaryFile([bytes], { type: 'image/png' });
  const owned = await ownImageBytes(source);
  expired = true;
  await assert.rejects(() => ownImageBytes(source, '参考图 2'), /参考图 2.*原始文件已失效/);
  assert.deepEqual(new Uint8Array(await owned.arrayBuffer()), bytes);
});
test('empty, unreadable, mismatched length and mislabeled non-image imports stop before planning', async () => {
  await assert.rejects(() => ownImageBytes(new Blob()), /没有可读取/);
  await assert.rejects(
    () => ownImageBytes(new Blob(['<html>not an image</html>'], { type: 'image/jpeg' })),
    /实际数据不是/,
  );
  class TruncatedFile extends Blob {
    async arrayBuffer() {
      return new ArrayBuffer(1);
    }
  }
  await assert.rejects(() => ownImageBytes(new TruncatedFile([bytes])), /读取不完整/);
});
test('storage messages distinguish quota, unreadable images, serialization and unknown failures', () => {
  assert.match(storageFailureMessage({ name: 'QuotaExceededError' }), /额度不足/);
  assert.match(storageFailureMessage({ name: 'NotReadableError' }), /原始文件已失效/);
  assert.match(storageFailureMessage({ name: 'DataCloneError' }), /不代表空间不足/);
  assert.match(storageFailureMessage({ name: 'UnknownError' }), /尚不能认定为空间不足/);
  assert.match(storageFailureMessage({ name: 'SecurityError' }), /拒绝访问/);
  assert.match(storageFailureMessage({ name: 'InvalidStateError' }), /连接已关闭/);
});
