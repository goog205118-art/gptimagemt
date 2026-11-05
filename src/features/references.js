import { $, icon } from '../core/dom.js';
import { revealContent } from '../ui/motion.js';
import { state, taskById, taskTitle } from '../core/state.js';
import { extension, fetchImage, outputBlob, pruneURLs, referenceURL } from '../core/assets.js';
import { escapeHTML, uid } from '../core/utils.js';
import { MAX_REFS, ROLE_NAMES } from '../core/config.js';
import { ownImageBytes, decodeImageBlob } from '../core/image-input.js';
import { expandComposer, renderEditContext, scheduleDraft, updateSend } from './composer.js';
import { runtime } from '../core/runtime.js';
import { guard, notify, setStatus } from '../ui/dialogs.js';
function renderRefs() {
  const previous = new Set(
    Array.from($('refs').querySelectorAll('[data-ref]'), (ref) => ref.dataset.ref),
  );
  $('refs').hidden = !state.refs.length;
  $('clearRefs').hidden = !state.refs.length;
  $('referenceSettingsBtn').hidden = !state.refs.length;
  if (!state.refs.length) $('composer').classList.remove('is-ref-editing');
  const editing = $('composer').classList.contains('is-ref-editing');
  $('referenceSettingsBtn').setAttribute('aria-expanded', String(editing));
  $('referenceSettingsBtn').textContent = editing ? '收起参考设置' : '参考设置';
  $('refs').innerHTML = state.refs
    .map(
      (ref, i) =>
        `<div class="reference" data-ref="${ref.id}"><div class="reference-main"><img draggable="true" data-ref-id="${ref.id}" src="${referenceURL(ref)}" alt="参考图 ${i + 1}：${escapeHTML(ref.name)}"><span class="ref-number">${i + 1}${state.mask?.assetId === ref.id ? ' · 蒙版' : ''}</span><button type="button" class="remove" data-remove="${ref.id}" aria-label="移除参考图 ${i + 1}">${icon('close')}</button></div><select data-role="${ref.id}" aria-label="参考图 ${i + 1} 用途">${Object.entries(
          ROLE_NAMES,
        )
          .map(
            ([value, label]) =>
              `<option value="${value}" ${value === (ref.role || 'general') ? 'selected' : ''}>${label}</option>`,
          )
          .join(
            '',
          )}</select><input type="text" data-ref-note="${ref.id}" value="${escapeHTML(ref.note || '')}" placeholder="参考什么 / 保留什么" maxlength="300" aria-label="参考图 ${i + 1} 说明"><div class="ref-order"><span class="ref-name" title="${escapeHTML(ref.name)}">${escapeHTML(ref.name)}</span><div><button type="button" data-move="${ref.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="参考图 ${i + 1} 前移">${icon('chevron-left')}</button><button type="button" data-move="${ref.id}" data-dir="1" ${i === state.refs.length - 1 ? 'disabled' : ''} aria-label="参考图 ${i + 1} 后移">${icon('chevron-right')}</button></div></div></div>`,
    )
    .join('');
  for (const ref of $('refs').querySelectorAll('[data-ref]')) {
    if (!previous.has(ref.dataset.ref)) revealContent(ref);
  }
  pruneURLs();
}
function addFiles(files, deferFailure = false) {
  const source = Array.from(files),
    available = Math.max(0, MAX_REFS - state.refs.length);
  const list = source.slice(0, available);
  if (!list.length) {
    if (source.length) notify('最多添加 16 张参考图。');
    return Promise.resolve({ count: 0, errors: [], full: !!source.length });
  }
  // Start consuming drag/clipboard files during the event, before waiting for
  // other uploads. Wrap errors immediately so queued work cannot reject unhandled.
  const prepared = list.map((file) =>
    ownImageBytes(file, file.name || '参考图').then(
      (blob) => ({ blob }),
      (error) => ({ error }),
    ),
  );
  state.adding++;
  updateSend();
  runtime.uploadChain = runtime.uploadChain
    .catch(() => {})
    .then(async () => {
      let count = 0;
      const errors = source.length > available ? ['最多添加 16 张参考图，其余图片未加入。'] : [];
      for (const [index, file] of list.entries()) {
        if (state.refs.length >= MAX_REFS) {
          errors.push('最多添加 16 张参考图。');
          break;
        }
        try {
          const result = await prepared[index];
          if (result.error) throw result.error;
          const image = await decodeImageBlob(result.blob, file.name || '参考图');
          image.close();
          state.refs.push({
            id: uid(),
            name: file.name || '参考图.png',
            role: 'general',
            note: '',
            blob: result.blob,
          });
          count++;
        } catch (e) {
          errors.push(e.message);
        }
      }
      renderRefs();
      scheduleDraft();
      if (count) {
        expandComposer();
        setStatus(`已添加 ${count} 张参考图，可为每张选择用途。`);
      }
      if (errors.length && (!deferFailure || count)) notify(errors.join(' '));
      return { count, errors };
    })
    .finally(() => {
      state.adding--;
      updateSend();
    });
  return runtime.uploadChain;
}
function hasDrag(e) {
  return Array.from(e.dataTransfer?.types || []).some((t) =>
    ['Files', 'application/x-openlux-image', 'text/uri-list'].includes(t),
  );
}
async function useAsReference(t) {
  const blob = await outputBlob(t);
  await addFiles([
    new File([blob], `作品-${taskTitle(t).slice(0, 25)}.${extension(blob)}`, {
      type: blob.type,
    }),
  ]);
}
function mountFeaturesReferences() {
  $('fileInput').onchange = guard(async (e) => {
    await addFiles(e.target.files);
    e.target.value = '';
  });
  $('refs').onclick = (e) => {
    const remove = e.target.closest('[data-remove]'),
      move = e.target.closest('[data-move]');
    if (remove) {
      state.refs = state.refs.filter((r) => r.id !== remove.dataset.remove);
      if (state.mask?.assetId === remove.dataset.remove) state.mask = null;
    } else if (move) {
      const i = state.refs.findIndex((r) => r.id === move.dataset.move),
        j = i + Number(move.dataset.dir);
      if (j >= 0 && j < state.refs.length) {
        if (state.mask && (i === 0 || j === 0)) {
          notify('蒙版绑定第一张底图；先清除蒙版或重新涂抹，再调整顺序。');
          return;
        }
        [state.refs[i], state.refs[j]] = [state.refs[j], state.refs[i]];
      }
    } else return;
    renderRefs();
    renderEditContext();
    scheduleDraft();
  };
  $('refs').onchange = (e) => {
    if (e.target.dataset.role) {
      const ref = state.refs.find((r) => r.id === e.target.dataset.role);
      if (ref) ref.role = e.target.value;
      scheduleDraft();
    }
  };
  $('refs').oninput = (e) => {
    if (e.target.dataset.refNote) {
      const ref = state.refs.find((r) => r.id === e.target.dataset.refNote);
      if (ref) ref.note = e.target.value;
      scheduleDraft();
    }
  };
  addEventListener('paste', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const files = Array.from(e.clipboardData?.items || [])
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  addEventListener('dragenter', (e) => {
    if (document.querySelector('dialog[open]') || !hasDrag(e)) return;
    e.preventDefault();
    runtime.dragDepth++;
    $('dropOverlay').hidden = false;
  });
  addEventListener('dragover', (e) => {
    if (!hasDrag(e) || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  addEventListener('dragleave', () => {
    runtime.dragDepth = Math.max(0, runtime.dragDepth - 1);
    if (!runtime.dragDepth) $('dropOverlay').hidden = true;
  });
  addEventListener('dragend', () => {
    runtime.dragDepth = 0;
    $('dropOverlay').hidden = true;
  });
  addEventListener(
    'drop',
    guard(async (e) => {
      if (!hasDrag(e)) return;
      e.preventDefault();
      runtime.dragDepth = 0;
      $('dropOverlay').hidden = true;
      if (document.querySelector('dialog[open]')) return;
      const internal = e.dataTransfer.getData('application/x-openlux-image');
      const uri = e.dataTransfer
        .getData('text/uri-list')
        .split(/\r?\n/)
        .find((s) => s && !s.startsWith('#'));
      if (internal) {
        const task = taskById(internal),
          ref =
            state.refs.find((r) => r.id === internal) ||
            state.tasks.flatMap((t) => t.refs || []).find((r) => r.id === internal);
        if (task) await useAsReference(task);
        else if (ref) {
          if (state.refs.some((r) => r.id === ref.id)) {
            notify('这张图已在当前参考图中。');
            return;
          }
          await addFiles([
            new File([ref.blob], ref.name, {
              type: ref.blob.type,
            }),
          ]);
        }
        if (task || ref) return;
      }
      if (e.dataTransfer.files.length) {
        const result = await addFiles(e.dataTransfer.files, !!uri);
        if (!uri || result?.count || result?.full || !result) return;
      }
      if (uri) {
        const blob = await fetchImage(uri);
        await addFiles([
          new File([blob], '拖入的参考图.' + extension(blob), {
            type: blob.type,
          }),
        ]);
      }
    }),
  );
}
export { mountFeaturesReferences, renderRefs, useAsReference };
