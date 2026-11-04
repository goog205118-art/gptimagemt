import { $ } from '../core/dom.js';
import { escapeHTML } from '../core/utils.js';
const floating = {
  parameterOpen: false,
  tab: 'image',
  select: null,
  trigger: null,
  query: '',
  root: null,
};
const CHEVRON =
  '<svg class="picker-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
const pickerRoot = document.createElement('div');
let syncingPickers = false,
  pickerSyncQueued = false;
function revealFloating(el) {
  el.hidden = false;
  if (el.showPopover && !el.matches(':popover-open')) el.showPopover();
}
function concealFloating(el) {
  if (el.hidePopover && el.matches(':popover-open')) el.hidePopover();
  el.hidden = true;
}
function positionPanel(panel, anchor, preferAbove = true, alignLeft = false) {
  if (panel.hidden || !anchor?.isConnected) return;
  const edge = 12,
    gap = 8,
    v = window.visualViewport,
    left = (v?.offsetLeft || 0) + edge,
    top = (v?.offsetTop || 0) + edge,
    right = (v?.offsetLeft || 0) + (v?.width || innerWidth) - edge,
    bottom = (v?.offsetTop || 0) + (v?.height || innerHeight) - edge,
    r = anchor.getBoundingClientRect();
  panel.style.maxHeight = Math.max(80, bottom - top) + 'px';
  panel.style.maxWidth = Math.max(160, right - left) + 'px';
  const p = panel.getBoundingClientRect(),
    above = r.top - top - gap,
    below = bottom - r.bottom - gap;
  let y;
  if (preferAbove)
    y =
      above >= p.height
        ? r.top - p.height - gap
        : below >= p.height
          ? r.bottom + gap
          : Math.max(top, Math.min(r.top - p.height - gap, bottom - p.height));
  else
    y =
      below >= p.height
        ? r.bottom + gap
        : above >= p.height
          ? r.top - p.height - gap
          : Math.max(top, Math.min(r.bottom + gap, bottom - p.height));
  panel.style.left =
    Math.max(left, Math.min(alignLeft ? r.left : r.right - p.width, right - p.width)) + 'px';
  panel.style.top = Math.max(top, Math.min(y, bottom - p.height)) + 'px';
}
function positionFloatingPanels() {
  if (floating.parameterOpen) positionPanel($('advanced'), $('advancedToggle'), true, true);
  if (floating.select && floating.trigger) positionPanel(pickerRoot, floating.trigger, false);
}
function selectParameterTab(tab, focus = false) {
  if (!['image', 'output', 'task', 'batch'].includes(tab)) return;
  floating.tab = tab;
  document.querySelectorAll('[data-param-tab]').forEach((b) => {
    const chosen = b.dataset.paramTab === tab;
    b.setAttribute('aria-selected', String(chosen));
    b.tabIndex = chosen ? 0 : -1;
  });
  document.querySelectorAll('.parameter-pane').forEach((p) => (p.hidden = p.id !== 'pane-' + tab));
  $('advanced').querySelector('.parameter-body').scrollTop = 0;
  closeSelectPicker(false);
  if (focus) $('tab-' + tab).focus();
  positionFloatingPanels();
}
function toggleParameterPanel() {
  if (floating.parameterOpen) {
    closeParameterPanel(true);
    return;
  }
  closeSelectPicker(false);
  syncPickers();
  selectParameterTab('image');
  floating.parameterOpen = true;
  $('advancedToggle').setAttribute('aria-expanded', 'true');
  revealFloating($('advanced'));
  positionFloatingPanels();
  $('tab-image').focus({
    preventScroll: true,
  });
}
function closeParameterPanel(restoreFocus = false) {
  if (!floating.parameterOpen) {
    if (!$('advanced').hidden) concealFloating($('advanced'));
    return;
  }
  closeSelectPicker(false);
  floating.parameterOpen = false;
  concealFloating($('advanced'));
  $('advancedToggle').setAttribute('aria-expanded', 'false');
  if (restoreFocus)
    $('advancedToggle').focus({
      preventScroll: true,
    });
}
const QUALITY_LABELS = {
  low: '预览',
  medium: '标准',
  high: '精细',
  xhigh: '超清',
  max: '极致',
  auto: '自动',
};
function ratioInfo(value) {
  if (value === 'auto')
    return {
      label: '自动',
      detail: '自适应',
      w: 20,
      h: 20,
      auto: true,
    };
  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match)
    return {
      label: value,
      detail: '自定义',
      w: 22,
      h: 22,
    };
  const w = Number(match[1]),
    h = Number(match[2]);
  function gcd(a, b) {
    return b ? gcd(b, a % b) : a;
  }
  const d = gcd(w, h),
    factor = Math.max(w, h) / 24;
  return {
    label: `${w / d}:${h / d}`,
    detail: value === '2160x3840' ? '4K' : String(Math.max(w, h)),
    w: w / factor,
    h: h / factor,
  };
}
function ratioShape(info) {
  if (info.auto)
    return '<svg viewBox="0 0 30 28" aria-hidden="true"><path d="M5 10V5h5m10 0h5v5m0 8v5h-5m-10 0H5v-5"/><path d="m12 14 2 2 4-5"/></svg>';
  return `<svg viewBox="0 0 30 28" aria-hidden="true"><rect x="${(30 - info.w) / 2}" y="${(28 - info.h) / 2}" width="${info.w}" height="${info.h}" rx="2"/></svg>`;
}
function fieldLabel(select) {
  if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
  const label = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
  return label?.textContent.trim() || '选择选项';
}
function ensurePicker(select) {
  select.classList.add('picker-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  if (select.hasAttribute('data-choice-source')) return null;
  let button = select.nextElementSibling;
  if (!button?.matches('.picker-button')) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-button';
    button.innerHTML = '<span class="picker-text"></span>' + CHEVRON;
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-controls', 'pickerOptions');
    button.setAttribute('aria-expanded', 'false');
    select.after(button);
    button.onclick = () => openSelectPicker(select, button);
    button.onkeydown = (e) => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        openSelectPicker(select, button, e.key);
      }
    };
  }
  button.disabled = select.disabled;
  button.setAttribute('aria-label', fieldLabel(select));
  if (select.id) button.dataset.selectFor = select.id;
  const label = select.selectedOptions[0]?.textContent || '请选择';
  const text = button.querySelector('.picker-text');
  if (text.textContent !== label) text.textContent = label;
  button.title = label;
  return button;
}
function renderChoiceSet(group) {
  const id = group.dataset.choices,
    source = $(id);
  if (!source) return;
  source.classList.add('picker-source');
  source.tabIndex = -1;
  source.setAttribute('aria-hidden', 'true');
  const choices =
    id === 'n'
      ? [1, 2, 3, 4].map((n) => ({
          value: String(n),
          text: n + ' 张',
          disabled: false,
        }))
      : Array.from(source.options).map((o) => ({
          value: o.value,
          text: o.textContent,
          disabled: o.disabled,
        }));
  const signature = JSON.stringify([source.value, source.disabled, choices]);
  if (group.dataset.signature === signature) return;
  group.dataset.signature = signature;
  group.innerHTML = choices
    .map((o) => {
      const selected = String(source.value) === o.value,
        disabled = source.disabled || o.disabled;
      let content = escapeHTML(id === 'quality' ? QUALITY_LABELS[o.value] || o.text : o.text);
      if (id === 'size') {
        const info = ratioInfo(o.value);
        content = `<span class="ratio-shape">${ratioShape(info)}</span><span class="ratio-text">${escapeHTML(info.label)}</span><small>${escapeHTML(info.detail)}</small>`;
      }
      return `<button type="button" class="${id === 'size' ? 'choice-tile' : 'choice-segment'}" data-choice-for="${id}" data-choice-value="${escapeHTML(o.value)}" aria-pressed="${selected}" aria-label="${escapeHTML(id === 'size' ? o.text : id === 'quality' ? o.text : o.text)}" ${disabled ? 'disabled' : ''}>${content}</button>`;
    })
    .join('');
}
function syncPickers() {
  if (syncingPickers) return;
  syncingPickers = true;
  try {
    document.querySelectorAll('select').forEach(ensurePicker);
    document.querySelectorAll('[data-choices]').forEach(renderChoiceSet);
    const model = $('model').selectedOptions[0]?.textContent || '选择模型',
      ratio = ratioInfo($('size').value),
      quality = QUALITY_LABELS[$('quality').value] || $('quality').value,
      n = $('n').value;
    for (const [id, text] of [
      ['summaryModel', model],
      ['summarySize', ratio.label],
      ['summaryQuality', quality],
      ['summaryCount', '×' + n],
    ])
      if ($(id).textContent !== text) $(id).textContent = text;
    $('advancedToggle').title = `${model} · ${$('size').value} · ${quality} · 每方案 ${n} 张`;
    $('advancedToggle').setAttribute('aria-label', '生成设置：' + $('advancedToggle').title);
    document.querySelectorAll('[data-step-for]').forEach((b) => {
      const source = $(b.dataset.stepFor),
        next = Number(source.value) + Number(b.dataset.step);
      b.disabled = source.disabled || next < Number(source.min) || next > Number(source.max);
    });
  } finally {
    syncingPickers = false;
  }
}
function queuePickerSync() {
  if (pickerSyncQueued) return;
  pickerSyncQueued = true;
  queueMicrotask(() => {
    pickerSyncQueued = false;
    syncPickers();
  });
}
function emitControlChange(source) {
  source.dispatchEvent(
    new Event('input', {
      bubbles: true,
    }),
  );
  source.dispatchEvent(
    new Event('change', {
      bubbles: true,
    }),
  );
  syncPickers();
  positionFloatingPanels();
}
function optionDescription(select, option) {
  if (select.id === 'model') return option.value;
  return '';
}
function pickerOptionHTML(option, index, select) {
  const description = optionDescription(select, option);
  return `<button type="button" role="option" class="picker-option" id="picker-option-${index}" data-option-index="${index}" aria-selected="${option.value === select.value}" ${option.disabled ? 'disabled' : ''}><span class="option-copy"><span class="option-label">${escapeHTML(option.textContent)}</span>${description ? `<small>${escapeHTML(description)}</small>` : ''}</span><svg class="option-check" viewBox="0 0 18 18" aria-hidden="true"><path d="m4 9 3 3 7-7"/></svg></button>`;
}
function renderPickerOptions() {
  const select = floating.select;
  if (!select) return;
  const query = floating.query.toLowerCase(),
    options = Array.from(select.options)
      .map((option, index) => ({
        option,
        index,
      }))
      .filter(
        ({ option }) =>
          !query || (option.textContent + ' ' + option.value).toLowerCase().includes(query),
      );
  pickerRoot.querySelector('.picker-list').innerHTML =
    options.map(({ option, index }) => pickerOptionHTML(option, index, select)).join('') ||
    '<div class="picker-empty">没有匹配的选项</div>';
}
function openSelectPicker(select, button, key) {
  if (select.disabled) return;
  if (floating.select === select && !pickerRoot.hidden) {
    closeSelectPicker(true);
    return;
  }
  closeSelectPicker(false);
  const owner = button.closest('dialog') || button.closest('#advanced') || document.body;
  owner.append(pickerRoot);
  floating.select = select;
  floating.trigger = button;
  floating.query = '';
  pickerRoot.innerHTML = `<div class="picker-caption">${escapeHTML(fieldLabel(select))}</div>${select.options.length > 7 ? '<input type="search" class="picker-search" placeholder="搜索选项…" aria-label="搜索选项">' : ''}<div class="picker-list" id="pickerOptions" role="listbox" aria-label="${escapeHTML(fieldLabel(select))}"></div>`;
  renderPickerOptions();
  pickerRoot.style.width =
    Math.min(
      innerWidth - 24,
      Math.max(button.getBoundingClientRect().width, select.id === 'model' ? 330 : 220),
    ) + 'px';
  button.setAttribute('aria-expanded', 'true');
  revealFloating(pickerRoot);
  positionFloatingPanels();
  const choices = pickerOptions(),
    selected = choices.find((b) => b.getAttribute('aria-selected') === 'true');
  if (key === 'Home')
    choices[0]?.focus({
      preventScroll: true,
    });
  else if (key === 'End')
    choices.at(-1)?.focus({
      preventScroll: true,
    });
  else
    (selected || choices[0])?.focus({
      preventScroll: true,
    });
  selected?.scrollIntoView({
    block: 'nearest',
  });
  const search = pickerRoot.querySelector('.picker-search');
  if (search)
    search.oninput = () => {
      floating.query = search.value;
      renderPickerOptions();
      positionFloatingPanels();
    };
}
function closeSelectPicker(restoreFocus = false) {
  if (!floating.select && pickerRoot.hidden) return;
  const trigger = floating.trigger;
  concealFloating(pickerRoot);
  trigger?.setAttribute('aria-expanded', 'false');
  floating.select = null;
  floating.trigger = null;
  floating.query = '';
  if (restoreFocus && trigger?.isConnected && !trigger.disabled)
    trigger.focus({
      preventScroll: true,
    });
}
function pickerOptions() {
  return Array.from(pickerRoot.querySelectorAll('[role=option]:not(:disabled)'));
}
function choosePickerOption(index) {
  const select = floating.select,
    option = select?.options[index];
  if (!select || !option || option.disabled) return;
  closeSelectPicker(true);
  select.value = option.value;
  emitControlChange(select);
}
function mountUiPickers() {
  pickerRoot.className = 'select-popover';
  pickerRoot.id = 'selectPopover';
  pickerRoot.setAttribute('popover', 'manual');
  pickerRoot.hidden = true;
  document.body.append(pickerRoot);
  floating.root = pickerRoot;
  $('parameterClose').onclick = $('parameterDone').onclick = () => closeParameterPanel(true);
  document.querySelectorAll('[data-param-tab]').forEach((b) => {
    b.onclick = () => selectParameterTab(b.dataset.paramTab);
    b.onkeydown = (e) => {
      const tabs = Array.from(document.querySelectorAll('[data-param-tab]')),
        i = tabs.indexOf(b);
      let next;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      if (next !== undefined) {
        e.preventDefault();
        selectParameterTab(tabs[next].dataset.paramTab, true);
      }
    };
  });
  $('advancedToggle').onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!floating.parameterOpen) toggleParameterPanel();
    }
  };
  $('advanced').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) {
      e.preventDefault();
      e.target.dispatchEvent(
        new Event('change', {
          bubbles: true,
        }),
      );
      e.target.blur();
    }
  });
  $('advanced').addEventListener('toggle', (e) => {
    if (e.newState === 'closed' && floating.parameterOpen) {
      floating.parameterOpen = false;
      $('advanced').hidden = true;
      $('advancedToggle').setAttribute('aria-expanded', 'false');
      closeSelectPicker(false);
    }
  });
  new MutationObserver((records) => {
    if (
      records.some(
        (r) =>
          r.target instanceof HTMLSelectElement ||
          r.target.parentElement?.closest('select') ||
          Array.from(r.addedNodes).some(
            (n) => n.nodeType === 1 && (n.matches('select') || n.querySelector('select')),
          ),
      )
    )
      queuePickerSync();
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });
  $('advanced').addEventListener('click', (e) => {
    const choice = e.target.closest('[data-choice-for]'),
      step = e.target.closest('[data-step-for]');
    if (choice) {
      const source = $(choice.dataset.choiceFor);
      if (source.disabled) return;
      const focused = document.activeElement === choice,
        value = choice.dataset.choiceValue;
      source.value = value;
      emitControlChange(source);
      if (focused)
        $('advanced')
          .querySelector(
            `[data-choice-for="${source.id}"][data-choice-value="${CSS.escape(value)}"]`,
          )
          ?.focus({
            preventScroll: true,
          });
    }
    if (step) {
      const source = $(step.dataset.stepFor);
      if (source.disabled) return;
      source.value = Math.max(
        Number(source.min),
        Math.min(Number(source.max), Number(source.value) + Number(step.dataset.step)),
      );
      emitControlChange(source);
    }
  });
  $('advanced').addEventListener('keydown', (e) => {
    const choice = e.target.closest('[data-choice-for]');
    if (!choice || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const choices = Array.from(choice.parentElement.querySelectorAll('button:not(:disabled)')),
      i = choices.indexOf(choice),
      next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? choices.length - 1
            : e.key === 'ArrowRight'
              ? (i + 1) % choices.length
              : (i - 1 + choices.length) % choices.length;
    e.preventDefault();
    choices[next]?.focus();
  });
  for (const id of ['concurrency', 'timeout', 'compression'])
    $(id).addEventListener('blur', () => {
      const source = $(id),
        raw = source.value.trim(),
        number = Number(raw);
      source.value =
        raw !== '' && Number.isFinite(number)
          ? Math.max(Number(source.min), Math.min(Number(source.max), Math.floor(number)))
          : source.defaultValue;
      emitControlChange(source);
    });
  pickerRoot.onclick = (e) => {
    const button = e.target.closest('[data-option-index]');
    if (button) choosePickerOption(Number(button.dataset.optionIndex));
  };
  pickerRoot.onkeydown = (e) => {
    if (e.key === 'Escape') return;
    const choices = pickerOptions(),
      index = choices.indexOf(document.activeElement);
    let next;
    if (e.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % choices.length;
    if (e.key === 'ArrowUp')
      next = index < 0 ? choices.length - 1 : (index - 1 + choices.length) % choices.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = choices.length - 1;
    if (next !== undefined) {
      e.preventDefault();
      choices[next]?.focus();
    }
    if (e.key === 'Tab') closeSelectPicker(true);
  };
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (
        floating.select &&
        !pickerRoot.contains(e.target) &&
        !floating.trigger?.contains(e.target)
      )
        closeSelectPicker(false);
      if (
        floating.parameterOpen &&
        !$('advanced').contains(e.target) &&
        !$('advancedToggle').contains(e.target)
      )
        closeParameterPanel(false);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (floating.select) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeSelectPicker(true);
      } else if (floating.parameterOpen) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeParameterPanel(true);
      }
    },
    true,
  );
  document.addEventListener('change', queuePickerSync);
  document.addEventListener('input', (e) => {
    if (e.target.closest('#advanced')) queuePickerSync();
  });
  document.addEventListener('click', (e) => {
    const label = e.target.closest('label[for]');
    if (!label) return;
    const source = $(label.htmlFor);
    if (source?.matches('select:not([data-choice-source])')) {
      e.preventDefault();
      const button = ensurePicker(source);
      if (button && !button.disabled) openSelectPicker(source, button);
    }
  });
  document.addEventListener('close', () => closeSelectPicker(false), true);
  document.addEventListener(
    'scroll',
    (e) => {
      if (floating.select && !pickerRoot.contains(e.target)) closeSelectPicker(false);
      if (floating.parameterOpen) positionPanel($('advanced'), $('advancedToggle'), true, true);
    },
    true,
  );
  addEventListener('resize', positionFloatingPanels);
  window.visualViewport?.addEventListener('resize', positionFloatingPanels);
  $('advanced')
    .querySelector('.preserve-details')
    .addEventListener('toggle', positionFloatingPanels);
  syncPickers();
}
export {
  closeParameterPanel,
  closeSelectPicker,
  floating,
  mountUiPickers,
  pickerRoot,
  positionFloatingPanels,
  syncPickers,
  toggleParameterPanel,
};
