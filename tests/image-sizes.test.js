import test from 'node:test';
import assert from 'node:assert/strict';
import {
  imageSizeRules, imageSizeError, validGptSize, sizeFromRatio,
  experimentalImageSize, imageSizeRatio,
} from '../shared/image-sizes.js';

test('GPT Image 2 accepts custom dimensions and exact edge, pixel and ratio boundaries', () => {
  for (const size of ['2000x2000', '1536x864', '2048x1152', '3840x2160', '2160x3840', '1024x640', '3840x1280', '1280x3840', 'auto']) {
    assert.equal(validGptSize(size, 'gpt-image-2'), true, size);
  }
  for (const size of ['1920x1080', '1080x1920', '512x512', '4000x1024', '3072x3072', '2048x640', '0x1024', '1024x0', '0x0', 'NaNx1024', '1024x', 'x1024', '1e3x1024', '1024.5x1024', '1024X1024', null, undefined, 1024]) {
    assert.equal(validGptSize(size, 'gpt-image-2'), false, String(size));
  }
  assert.match(imageSizeError('1920x1080', 'gpt-image-2'), /16/);
  assert.match(imageSizeError('4000x1024', 'gpt-image-2'), /3840/);
  assert.match(imageSizeError('3072x3072', 'gpt-image-2'), /8,294,400/);
  assert.match(imageSizeError('2048x640', 'gpt-image-2'), /3:1/);
  assert.match(imageSizeError('512x512', 'gpt-image-2'), /655,360/);
});

test('snapshots and channel suffixes retain rules while old and unknown aliases stay conservative', () => {
  for (const model of ['gpt-image-2', 'gpt-image-2-c', 'gpt-image-2-fast', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst-2026-09-08-c-stable']) {
    assert.equal(imageSizeRules(model).flexible, true, model);
    assert.equal(validGptSize('2000x2000', model), true, model);
  }
  for (const model of ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini', 'chatgpt-image-latest', 'unknown', 'gpt-image-2-unknown']) {
    assert.equal(imageSizeRules(model).flexible, false, model);
    assert.equal(validGptSize('2000x2000', model), false, model);
    for (const size of ['auto', '1024x1024', '1024x1536', '1536x1024']) assert.equal(validGptSize(size, model), true);
  }
});

test('ratio conversion preserves exact common ratios and aligns fractional ratios to legal dimensions', () => {
  for (const [a, b, edge, expected] of [[16, 9, 2048, '2048x1152'], [9, 16, 3840, '2160x3840'], [1, 1, 2000, '2000x2000'], [3, 1, 3840, '3840x1280']]) {
    assert.equal(sizeFromRatio(a, b, edge, 'gpt-image-2'), expected);
  }
  for (const [a, b, edge] of [[16, 9, 1920], [2.35, 1, 2048], [1, 1, 512], [1, 3, 1000], [1, 1, 3840]]) {
    const size = sizeFromRatio(a, b, edge, 'gpt-image-2');
    assert.equal(validGptSize(size, 'gpt-image-2'), true, size);
    const [w, h] = size.split('x').map(Number);
    assert.ok(Math.abs(w / h / (a / b) - 1) < 0.02, size);
  }
  for (const args of [[0, 1, 1024], [-1, 1, 1024], [4, 1, 1024], [1, 4, 1024], [1, 1, 4096], ['', 1, 1024], [NaN, 1, 1024], [1, 1, Infinity]])
    assert.throws(() => sizeFromRatio(...args, 'gpt-image-2'));
  assert.throws(() => sizeFromRatio(1, 1, 1024, 'gpt-image-1.5'));
});

test('actual ratios and experimental resolution notices are independent of rendering quality', () => {
  assert.equal(imageSizeRatio('2048x1152'), '16:9');
  assert.equal(imageSizeRatio('1920x1088'), '30:17');
  assert.equal(imageSizeRatio('0x0'), '');
  assert.equal(experimentalImageSize('2560x1440', 'gpt-image-2'), false);
  assert.equal(experimentalImageSize('2000x2000', 'gpt-image-2'), true);
  assert.equal(experimentalImageSize('2160x3840', 'gpt-image-2'), true);
  assert.equal(experimentalImageSize('auto', 'gpt-image-2'), false);
});
