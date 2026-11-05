import { state } from '../core/state.js';
function priceFor(settings) {
  const key = settings.model + settings.route;
  const price = state.prefs.prices?.[key];
  return typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : null;
}
function money(price, currency = state.prefs.currency) {
  return `${currency === 'USD' ? '$' : '¥'}${Number(price).toFixed(2)}`;
}
function parsePriceRules(text) {
  const prices = {};
  for (const line of text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const match = line.match(/^([^=]+)=\s*(\d+(?:\.\d+)?)$/);
    if (!match || !Number.isFinite(Number(match[2])))
      throw new Error('价格格式应为：模型含路由 = 每张价格');
    prices[match[1].trim()] = Number(match[2]);
  }
  return prices;
}
function formatPriceRules(prices) {
  return Object.entries(prices || {})
    .map(([model, price]) => `${model} = ${price}`)
    .join('\n');
}
export { money, priceFor, parsePriceRules, formatPriceRules };
