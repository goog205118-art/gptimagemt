const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const numeric = (id, min, max, fallback) => {
  const x = Number($(id).value);
  const v = Number.isFinite(x) && x >= min ? Math.min(max, Math.floor(x)) : fallback;
  if (document.activeElement !== $(id)) $(id).value = v;
  return v;
};
export { $, icon, numeric };
