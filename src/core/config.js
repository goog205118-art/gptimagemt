const DEFAULT_BASE = 'https://api.openlux.ai/v1',
  MAX_REFS = 16,
  MAX_FILE = 25 * 1024 * 1024;
const ROLE_NAMES = {
  general: '一般参考',
  subject: '主体 / 产品',
  style: '风格',
  composition: '构图',
  palette: '配色',
  base: '编辑底图',
};
const STATUS_NAMES = {
  queued: '等待生成',
  running: '正在生成',
  retry_wait: '限流等待',
  success: '已完成',
  failed: '生成失败',
  unknown: '结果待核实',
  cancelled: '已取消',
  deleted: '已删除',
};
export { DEFAULT_BASE, MAX_FILE, MAX_REFS, ROLE_NAMES, STATUS_NAMES };
