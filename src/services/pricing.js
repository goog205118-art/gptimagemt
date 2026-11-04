import { state } from '../core/state.js';
function priceFor(settings) {
  const key = settings.model + settings.route;
  const price = state.prefs.prices?.[key];
  return typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : null;
}
function money(price, currency = state.prefs.currency) {
  return `${currency === 'USD' ? '$' : '¥'}${Number(price).toFixed(2)}`;
}
export { money, priceFor };
