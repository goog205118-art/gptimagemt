import { $ } from '../core/dom.js';
import { taskTitle } from '../core/state.js';
import { imageURL } from '../core/assets.js';
import { guard, showDialog } from '../ui/dialogs.js';
import { selectedTasks } from './gallery.js';
let comparison = {
  tasks: [],
  mode: 'side',
  zoom: 1,
  x: 0,
  y: 0,
  drag: null,
};
function compareTasks(tasks) {
  if (tasks.length !== 2 || tasks.some((t) => !t || t.status !== 'success'))
    throw new Error('请选择两张已完成图片进行对比。');
  comparison = {
    tasks,
    mode: 'side',
    zoom: 1,
    x: 0,
    y: 0,
    drag: null,
  };
  $('compareLabelA').textContent = 'A · ' + taskTitle(tasks[0]);
  $('compareLabelB').textContent = 'B · ' + taskTitle(tasks[1]);
  $('compareA').src = $('compareBase').src = imageURL(tasks[0]);
  $('compareB').src = $('compareTop').src = imageURL(tasks[1]);
  $('compareZoom').value = 1;
  $('compareSlider').value = 50;
  setCompareMode('side');
  applyCompareTransform();
  showDialog('compareDlg');
}
function setCompareMode(mode) {
  comparison.mode = mode;
  $('compareSide').hidden = mode !== 'side';
  $('compareOverlay').hidden = mode !== 'slider';
  $('compareSliderLabel').hidden = mode !== 'slider';
  document
    .querySelectorAll('[data-compare-mode]')
    .forEach((b) => b.classList.toggle('outlined', b.dataset.compareMode === mode));
  applyCompareClip();
}
function applyCompareTransform() {
  const transform = `translate(${comparison.x}px,${comparison.y}px) scale(${comparison.zoom})`;
  for (const id of ['compareA', 'compareB', 'compareBase', 'compareTop'])
    $(id).style.transform = transform;
  $('compareZoom').value = comparison.zoom;
  $('compareZoomText').textContent = Math.round(comparison.zoom * 100) + '%';
}
function applyCompareClip() {
  const value = Number($('compareSlider').value);
  $('compareClip').style.clipPath = `inset(0 ${100 - value}% 0 0)`;
  $('compareLine').style.left = value + '%';
}
function mountFeaturesComparison() {
  $('compareBtn').onclick = guard(() => compareTasks(selectedTasks()));
  document
    .querySelectorAll('[data-compare-mode]')
    .forEach((b) => (b.onclick = () => setCompareMode(b.dataset.compareMode)));
  $('compareZoom').oninput = () => {
    comparison.zoom = Number($('compareZoom').value);
    applyCompareTransform();
  };
  $('compareReset').onclick = () => {
    comparison.zoom = 1;
    comparison.x = 0;
    comparison.y = 0;
    applyCompareTransform();
  };
  $('compareSlider').oninput = applyCompareClip;
  document.querySelectorAll('[data-pan]').forEach((stage) => {
    stage.onpointerdown = (e) => {
      comparison.drag = {
        x: e.clientX,
        y: e.clientY,
        startX: comparison.x,
        startY: comparison.y,
      };
      stage.setPointerCapture(e.pointerId);
    };
    stage.onpointermove = (e) => {
      if (!comparison.drag) return;
      comparison.x = comparison.drag.startX + e.clientX - comparison.drag.x;
      comparison.y = comparison.drag.startY + e.clientY - comparison.drag.y;
      applyCompareTransform();
    };
    stage.onpointerup = stage.onpointercancel = () => (comparison.drag = null);
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        comparison.zoom = Math.max(1, Math.min(5, comparison.zoom + (e.deltaY < 0 ? 0.1 : -0.1)));
        applyCompareTransform();
      },
      {
        passive: false,
      },
    );
  });
}
export { compareTasks, mountFeaturesComparison };
