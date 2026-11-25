import { $ } from '../core/dom.js';
import {
  imageSizeError, imageSizeRatio, parseImageSize, experimentalImageSize, sizeFromRatio,
} from '../../shared/image-sizes.js';

let lastSize, notifyChange;
const flexibleHint = '宽高为 16 的倍数，单边 ≤3840；比例 1:3–3:1；总像素 655,360–8,294,400。';
const standardHint = '当前模型仅支持预设尺寸。切换 GPT Image 2 / 2.5 可自定义尺寸。';

function showSizeFeedback(message, error = false) {
  $('sizeFeedback').textContent = message;
  $('sizeFeedback').classList.toggle('is-error', error);
}
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
      $('customLongEdgeSlider').value = $('customLongEdge').value;
    }
  }
  const controls = $('customSizeControls');
  const highResolution = experimentalImageSize(size, profile.sizeRules) ? ' 实验性高分辨率。' : '';
  controls.title = profile.flexible ? flexibleHint + highResolution : standardHint;
  for (const input of controls.querySelectorAll('input, button')) input.disabled = !profile.flexible;
  const error = imageSizeError(size, profile.sizeRules);
  showSizeFeedback(error, !!error);
  for (const id of ['customWidth', 'customHeight']) $(id).setAttribute('aria-invalid', String(!!error));
}

export function initializeImageSizeControls(onChange) {
  notifyChange = onChange;
  for (const id of ['customWidth', 'customHeight']) $(id).addEventListener('input', () => {
    selectSize(`${$('customWidth').value}x${$('customHeight').value}`);
  });
  const longEdgeInput = $('customLongEdge');
  const longEdgeSlider = $('customLongEdgeSlider');
  longEdgeSlider.addEventListener('input', () => {
    longEdgeInput.value = longEdgeSlider.value;
  });
  longEdgeInput.addEventListener('input', () => {
    if (Number.isFinite(longEdgeInput.valueAsNumber)) longEdgeSlider.value = longEdgeInput.value;
  });
  $('calculateSize').addEventListener('click', () => {
    try {
      const ratioWidth = Number($('customRatioWidth').value);
      const ratioHeight = Number($('customRatioHeight').value);
      const longEdge = Number(longEdgeInput.value);
      const size = sizeFromRatio(ratioWidth, ratioHeight, longEdge, model());
      const { width, height } = parseImageSize(size);
      $('customWidth').value = width;
      $('customHeight').value = height;
      selectSize(size);
      if (width * ratioHeight !== height * ratioWidth || Math.max(width, height) !== longEdge)
        showSizeFeedback(`已对齐为 ${width} × ${height} · ${imageSizeRatio(size)}`);
    } catch (error) {
      showSizeFeedback(error.message, true);
    }
  });
}
