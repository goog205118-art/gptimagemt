const GPT_SEED_MODELS = [
  'gpt-image-2',
  'gpt-image-2-c',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare-c',
  'gpt-image-2.5-sunburst-c',
  'gpt-image-1.5',
  'gpt-image-1-mini',
  'gpt-image-1',
];
const GPT_ROUTE_SUFFIXES = ['-fast', '-intx', '-stable'];
function splitGptModel(value) {
  const id = String(value || '').trim(),
    suffix = GPT_ROUTE_SUFFIXES.find((s) => id.endsWith(s)) || '';
  return {
    id,
    core: suffix ? id.slice(0, -suffix.length) : id,
    route: suffix,
  };
}
function isGptImageModel(value) {
  const { core } = splitGptModel(value);
  return /^(?:gpt-image-(?:1(?:\.5)?(?:-mini)?|2(?:\.0)?)(?:-\d{4}-\d{2}-\d{2})?(?:-c)?|gpt-image-2\.5-(?:flare|sunburst)(?:-\d{4}-\d{2}-\d{2})?(?:-c)?|chatgpt-image-latest)$/.test(
    core,
  );
}
export { GPT_SEED_MODELS, GPT_ROUTE_SUFFIXES, splitGptModel, isGptImageModel };
