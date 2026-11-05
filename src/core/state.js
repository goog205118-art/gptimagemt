import { DEFAULT_BASE } from './config.js';
const state = {
  tasks: [],
  projects: [
    {
      id: 'default',
      name: '未分类',
    },
  ],
  presets: [],
  assets: [],
  ledger: [],
  agentRuns: [],
  agentMode: false,
  prefs: {
    concurrency: 3,
    autoRateRetry: true,
    currency: 'CNY',
    prices: {},
    customModels: [],
    grouped: false,
  },
  draft: {},
  refs: [],
  filter: 'all',
  projectFilter: 'all',
  search: '',
  selection: new Set(),
  selecting: false,
  visibleLimit: 60,
  queuePaused: false,
  key: '',
  base: DEFAULT_BASE,
  ready: false,
  adding: 0,
  submitting: false,
  parentId: null,
  editQueuedId: null,
  mask: null,
};
const controllers = new Map(),
  runtimeImages = new Map(),
  refURLs = new Map();
const active = (t) => ['queued', 'running', 'retry_wait'].includes(t.status);
const existing = (t) => t.status !== 'deleted';
const taskById = (id) => state.tasks.find((t) => t.id === id);
const projectName = (id) => state.projects.find((p) => p.id === id)?.name || '未分类';
const taskTitle = (t) => t.name || t.variant || t.prompt.slice(0, 40) || '未命名创作';
export {
  active,
  controllers,
  existing,
  projectName,
  refURLs,
  runtimeImages,
  state,
  taskById,
  taskTitle,
};
