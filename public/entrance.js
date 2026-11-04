// Runs before the first paint. A slow/failed application bundle must not hide the page forever.
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  root.dataset.entrance = 'pending';
  setTimeout(() => {
    if (root.dataset.entrance === 'pending') root.removeAttribute('data-entrance');
  }, 2200);
})();
