const runtime = {
  db: null,
  saveChain: Promise.resolve(),
  uploadChain: Promise.resolve(),
  draftTimer: null,
  toastTimer: null,
  dragDepth: 0,
  queueCounter: Date.now(),
  detailId: null,
  libraryTab: 'presets',
  presetSearch: '',
};
export { runtime };
