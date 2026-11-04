const uid = () =>
  crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
const escapeHTML = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
export { escapeHTML, uid };
