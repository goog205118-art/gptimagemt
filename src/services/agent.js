import { state } from '../core/state.js';
import { storageGet } from '../core/storage.js';
import { AGENT_MODEL } from '../../shared/agent-protocol.js';
import { ownImageBytes, decodeImageBlob } from '../core/image-input.js';

export const AGENT_CONNECTION_KEY = 'openlux_agent_connection_v1';
export function loadAgentConnection() {
  try {
    return JSON.parse(storageGet(AGENT_CONNECTION_KEY) || 'null') || {};
  } catch {
    return {};
  }
}
let connection = loadAgentConnection();
export function setAgentConnection(value) {
  connection = { ...value };
}
export function getAgentConnection() {
  return { model: AGENT_MODEL, useImageKey: true, strict: true, ...connection };
}
export function agentCredentials(config = getAgentConnection()) {
  const base = config.useImageKey ? state.base : config.base;
  const key = config.useImageKey ? state.key : config.apiKey;
  if (!key) throw new Error('请先在 Agent 设置中填写 Key，或连接生图 API 后复用当前 Key。');
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error('Agent API 地址无效。');
  }
  if (
    !['https://api.openlux.ai', 'https://api.openlux.uk'].includes(url.origin) ||
    url.pathname.replace(/\/$/, '') !== '/v1' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Agent 当前仅支持 OpenLux 官方 /v1 地址。');
  return { ...config, base, key, origin: url.origin };
}
export async function agentQuery(action, fields = {}, signal, config) {
  const { key, origin, model, strict } = agentCredentials(config);
  const response = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ action, origin, model, strict, ...fields }),
    signal: signal || AbortSignal.timeout(115000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Agent 接口没有返回有效数据，请检查网站部署。');
  }
  if (!response.ok || data.success === false) throw new Error(data.message || 'Agent 请求失败。');
  return data;
}
export async function referencePreviews(refs, signal) {
  const result = [];
  for (const [index, ref] of refs.entries()) {
    signal?.throwIfAborted();
    const label = `参考图 ${index + 1}${ref.name ? '（' + ref.name + '）' : ''}`;
    const blob = await ownImageBytes(ref.blob, label);
    const bitmap = await decodeImageBlob(blob, label);
    try {
      const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap.source || bitmap, 0, 0, canvas.width, canvas.height);
      let preview = canvas.toDataURL('image/jpeg', 0.65);
      if (preview.length > 180000) preview = canvas.toDataURL('image/jpeg', 0.35);
      if (preview.length > 180000) throw new Error('参考图预览过大，请减少图片细节或尺寸。');
      result.push(preview);
    } finally {
      bitmap.close();
    }
  }
  return result;
}
