import { runtime } from './runtime.js';
import { state } from './state.js';
import { storageWarning, clearStorageWarning } from '../ui/dialogs.js';
import { storageFailureMessage } from './storage-error.js';
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
    agentRuns: state.agentRuns,
    prefs: state.prefs,
    draft: state.draft,
    queuePaused: state.queuePaused,
  };
}
function persist() {
  if (!runtime.db) return Promise.resolve(false);
  const revision = ++runtime.saveRevision;
  let snapshot;
  try {
    snapshot = structuredClone(rootSnapshot());
  } catch (error) {
    storageWarning(storageFailureMessage(error), 'write');
    return Promise.resolve(false);
  }
  runtime.saveChain = runtime.saveChain
    .catch(() => {})
    .then(
      () =>
        new Promise((resolve, reject) => {
          const tx = runtime.db.transaction('state', 'readwrite');
          const request = tx.objectStore('state').put(snapshot, 'history');
          let writeError;
          request.onerror = () => {
            writeError = request.error;
          };
          tx.oncomplete = () => {
            if (revision === runtime.saveRevision) clearStorageWarning('write');
            resolve(true);
          };
          tx.onerror = () => reject(writeError || tx.error);
          tx.onabort = () =>
            reject(writeError || tx.error || new DOMException('Write aborted', 'AbortError'));
        }),
    )
    .catch((error) => {
      if (revision === runtime.saveRevision) storageWarning(storageFailureMessage(error), 'write');
      return false;
    });
  return runtime.saveChain;
}
export { openDB, persist, readDB, rootSnapshot, storageGet, storageSet };
