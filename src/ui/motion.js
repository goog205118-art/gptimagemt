const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const animations = new WeakMap();

export function revealContent(element) {
  if (!element || !element.getClientRects().length) return;
  animations.get(element)?.cancel();
  animations.set(
    element,
    element.animate(
      reduced()
        ? [{ opacity: 0.65 }, { opacity: 1 }]
        : [
            { opacity: 0.4, transform: 'translateY(4px)' },
            { opacity: 1, transform: 'none' },
          ],
      { duration: reduced() ? 70 : 200, easing: ease },
    ),
  );
}

export function captureCards(container) {
  return new Map(
    Array.from(container.querySelectorAll('[data-task-id]'), (card) => [
      card.dataset.taskId,
      { rect: card.getBoundingClientRect(), status: card.dataset.motionState },
    ]),
  );
}

export function transitionCards(container, previous) {
  let arrivals = 0;
  for (const card of container.querySelectorAll('[data-task-id]')) {
    const old = previous.get(card.dataset.taskId);
    if (!old) {
      if (arrivals++ < 12) revealContent(card);
    } else if (old.status !== card.dataset.motionState) {
      revealContent(card.querySelector('.card-visual'));
    } else if (!reduced()) {
      const rect = card.getBoundingClientRect(),
        x = old.rect.x - rect.x,
        y = old.rect.y - rect.y;
      if (Math.abs(x) + Math.abs(y) > 1 && Math.abs(y) < innerHeight) {
        card.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], {
          duration: 240,
          easing: ease,
        });
      }
    }
  }
}

export function updateSelection(group) {
  if (!group || !group.getClientRects().length) return;
  const selected = group.querySelector('button[aria-pressed="true"], button[aria-selected="true"]');
  if (!selected) return;
  let indicator = group.querySelector(':scope > .selection-indicator');
  const first = !indicator;
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'selection-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    group.append(indicator);
  }
  group.classList.add('has-selection-indicator');
  // Offset geometry is independent of an overlay's entrance transform.
  if (first) indicator.style.transition = 'none';
  indicator.style.width = selected.offsetWidth + 'px';
  indicator.style.height = selected.offsetHeight + 'px';
  indicator.style.transform = `translate(${selected.offsetLeft}px, ${selected.offsetTop}px)`;
  if (first) {
    indicator.getBoundingClientRect();
    indicator.style.transition = '';
  }
}

export function mountMotion() {
  const selector = '.segment-choices, .parameter-tabs, .filters, .library-tabs, .quota-tabs';
  let frame = 0;
  const update = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      document.querySelectorAll(selector).forEach(updateSelection);
    });
  };
  new MutationObserver(update).observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed', 'aria-selected', 'hidden', 'open'],
  });
  new ResizeObserver(update).observe(document.documentElement);
  const workspace = document.querySelector('.workspace');
  let scrollbarWidth = -1;
  new ResizeObserver(() => {
    const width = workspace.offsetWidth - workspace.clientWidth;
    if (width !== scrollbarWidth) {
      scrollbarWidth = width;
      document.documentElement.style.setProperty('--workspace-scrollbar', width + 'px');
    }
  }).observe(workspace);
  document.addEventListener('toggle', update, true);
  update();
}

export function beginEntrance() {
  const intro = document.getElementById('appIntro'),
    surface = document.getElementById('appSurface');
  if (reduced() || !intro || !surface) return () => {};
  const started = performance.now();
  let finishing = false;
  intro.hidden = false;
  surface.inert = true;
  surface.classList.add('is-entering');
  const release = () => {
    intro.hidden = true;
    surface.inert = false;
    surface.classList.remove('is-entering');
    surface.getAnimations().forEach((animation) => animation.cancel());
  };
  // A failed/slow startup must never leave the workspace hidden or inaccessible.
  const watchdog = setTimeout(release, 2200);
  return () => {
    if (finishing) return;
    finishing = true;
    setTimeout(
      () => {
        if (intro.hidden) return;
        surface.classList.remove('is-entering');
        surface.inert = false;
        intro.style.pointerEvents = 'none';
        const page = surface.animate(
          [
            { opacity: 0.3, filter: 'blur(6px)' },
            { opacity: 1, filter: 'blur(0)' },
          ],
          { duration: 460, easing: ease },
        );
        intro.animate(
          [
            { opacity: 1, filter: 'blur(0)', transform: 'scale(1)' },
            { opacity: 0, filter: 'blur(5px)', transform: 'scale(1.025)' },
          ],
          { duration: 320, easing: ease },
        );
        page.finished
          .catch(() => {})
          .finally(() => {
            clearTimeout(watchdog);
            release();
          });
      },
      Math.max(0, 320 - (performance.now() - started)),
    );
  };
}
