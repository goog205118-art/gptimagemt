import { $ } from '../core/dom.js';
import {
  imageSizeError, imageSizeRatio, parseImageSize, experimentalImageSize, sizeFromRatio,
} from '../../shared/image-sizes.js';

let lastSize, notifyChange;
const model = () => $('model').value;

function selectSize(size) {
  const select = $('size');
  let option = Array.from(select.options).find((item) => item.value === size);
  // Keep just one transient custom option so typing does not grow the preset grid.
  for (const item of Array.from(select.querySelectorAll('[data-custom-size]')))
    if (item !== option) item.remove();
  if (!option) {
    option = new Option(`自定义 · ${size}`, size);
    option.dataset.customSize = 'true';
    select.add(option);
  }
  select.value = size;
  lastSize = size;
  notifyChange?.();
}

export function syncImageSizeControls(profile) {
  if (!$('customSizeControls')) return;
  const size = $('size').value, dimensions = parseImageSize(size);
  if (size !== lastSize) {
    lastSize = size;
    if (dimensions) {
      $('customWidth').value = dimensions.width;
      $('customHeight').value = dimensions.height;
      const ratio = imageSizeRatio(size).split(':');
      $('customRatioWidth').value = ratio[0] || 1;
      $('customRatioHeight').value = ratio[1] || 1;
      $('customLongEdge').value = Math.max(dimensions.width, dimensions.height);
    }
  }
  for (const input of $('customSizeControls').querySelectorAll('input, button')) input.disabled = !profile.flexible;
  $('sizeRules').textContent = profile.flexible
    ? '宽高为 16 的倍数，单边 ≤3840；比例 1:3–3:1；总像素 655,360–8,294,400。'
    : '当前模型仅支持自动或标准三种尺寸。切换 GPT Image 2 / 2.5 可自定义宽高和比例。';
  const error = imageSizeError(size, profile.sizeRules);
  $('sizeFeedback').textContent = error || (size === 'auto' ? '由模型自动选择尺寸。' : `当前：${dimensions.width} × ${dimensions.height} · ${imageSizeRatio(size)}${experimentalImageSize(size, profile.sizeRules) ? ' · 实验性高分辨率' : ''}`);
  $('sizeFeedback').classList.toggle('is-error', !!error);
  for (const id of ['customWidth', 'customHeight']) $(id).setAttribute('aria-invalid', String(!!error));
}

export function initializeImageSizeControls(onChange) {
  notifyChange = onChange;
  for (const id of ['customWidth', 'customHeight']) $(id).addEventListener('input', () => {
    selectSize(`${$('customWidth').value}x${$('customHeight').value}`);
  });
  $('calculateSize').addEventListener('click', () => {
    try {
      const size = sizeFromRatio($('customRatioWidth').value, $('customRatioHeight').value, $('customLongEdge').value, model());
      const { width, height } = parseImageSize(size);
      $('customWidth').value = width;
      $('customHeight').value = height;
      selectSize(size);
      const feedback = $('sizeFeedback');
      feedback.textContent += '。已按模型规则换算，请核对实际尺寸和比例。';
    } catch (error) {
      $('sizeFeedback').textContent = `${error.message} 未应用，当前仍为 ${$('size').value}。`;
      $('sizeFeedback').classList.add('is-error');
    }
  });
}
