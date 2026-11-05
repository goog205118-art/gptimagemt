import { $ } from '../core/dom.js';
import { runtime } from '../core/runtime.js';
import { closeParameterPanel, closeSelectPicker } from './pickers.js';
function notify(message) {
  $('toast').textContent = message;
  clearTimeout(runtime.toastTimer);
  runtime.toastTimer = setTimeout(() => ($('toast').textContent = ''), 5000);
}
function setStatus(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function storageWarning(message, source = 'general') {
  $('storageNote').hidden = false;
  $('storageNote').textContent = message;
  $('storageNote').dataset.source = source;
}
function clearStorageWarning(source) {
  if ($('storageNote').dataset.source === source) {
    $('storageNote').hidden = true;
    $('storageNote').textContent = '';
    delete $('storageNote').dataset.source;
  }
}
function guard(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error(e);
      notify(e.message || '操作未完成，请重试。');
    }
  };
}
function showDialog(id) {
  closeParameterPanel(false);
  closeSelectPicker(false);
  if (!$(id).open) $(id).showModal();
}
let confirmResolver = null,
  nameResolver = null;
function askConfirm(title, message, button = '确认') {
  if (confirmResolver) return Promise.resolve(false);
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = message;
  $('confirmClear').textContent = button;
  showDialog('confirmDlg');
  return new Promise((resolve) => (confirmResolver = resolve));
}
function askName(title, initial = '') {
  if (nameResolver) return Promise.resolve(null);
  $('nameTitle').textContent = title;
  $('nameInput').value = initial;
  showDialog('nameDlg');
  $('nameInput').focus();
  return new Promise((resolve) => (nameResolver = resolve));
}
function mountUiDialogs() {
  document
    .querySelectorAll('[data-close]')
    .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
  $('confirmCancel').onclick = () => $('confirmDlg').close('cancel');
  $('confirmClear').onclick = () => $('confirmDlg').close('yes');
  $('confirmDlg').onclose = () => {
    confirmResolver?.($('confirmDlg').returnValue === 'yes');
    confirmResolver = null;
    $('confirmDlg').returnValue = '';
  };
  $('nameForm').onsubmit = (e) => {
    e.preventDefault();
    if ($('nameInput').value.trim()) $('nameDlg').close('save');
  };
  $('nameDlg').onclose = () => {
    nameResolver?.($('nameDlg').returnValue === 'save' ? $('nameInput').value.trim() : null);
    nameResolver = null;
    $('nameDlg').returnValue = '';
  };
}
export {
  askConfirm,
  askName,
  guard,
  mountUiDialogs,
  notify,
  setStatus,
  showDialog,
  storageWarning,
  clearStorageWarning,
};
