import { runtime } from './runtime.js';
import { state } from './state.js';
import { storageWarning } from '../ui/dialogs.js';
function storageGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storageSet(k, v) {
  try {
    v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
}
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('openlux-studio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('state');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('本地存储被其他窗口占用'));
  });
}
function readDB() {
  return new Promise((resolve, reject) => {
    const r = runtime.db.transaction('state').objectStore('state').get('history');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function rootSnapshot() {
  return {
    version: 3,
    tasks: state.tasks,
    projects: state.projects,
    presets: state.presets,
    assets: state.assets,
    ledger: state.ledger,
    prefs: state.prefs,
    draft: state.draft,
    queuePaused: state.queuePaused,
  };
}
function persist() {
  if (!runtime.db) return Promise.resolve(false);
  const snapshot = structuredClone(rootSnapshot());
  runtime.saveChain = runtime.saveChain
    .catch(() => {})
    .then(
      () =>
        new Promise((resolve, reject) => {
          const tx = runtime.db.transaction('state', 'readwrite');
          tx.objectStore('state').put(snapshot, 'history');
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    )
    .catch(() => {
      storageWarning(
        '本地保存失败，可能是空间不足。当前仍可使用，请先导出备份或下载图片，再清理旧记录。',
      );
      return false;
    });
  return runtime.saveChain;
}
export { openDB, persist, readDB, rootSnapshot, storageGet, storageSet };
