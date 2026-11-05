const ALLOWED_ORIGINS = new Set(['https://api.openlux.ai', 'https://api.openlux.uk']);
const MAX_BODY_BYTES = 16 * 1024;
export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function sendJSON(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(payload));
}
export async function readRequest(request, maxBodyBytes = MAX_BODY_BYTES) {
  if (request.method !== 'POST') throw new RequestError(405, '请使用 POST 查询。');
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new RequestError(403, '不接受跨站查询。');
  }
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new RequestError(403, '查询来源无效。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== request.headers.host) {
      throw new RequestError(403, '请从工具页面发起查询。');
    }
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new RequestError(415, '请发送 JSON 查询信息。');
  }
  const auth = request.headers.authorization || '';
  const match = /^Bearer ([^\s\r\n]{1,16000})$/i.exec(auth);
  if (!match) throw new RequestError(401, '请先填写有效的查询密钥。');
  let raw = request.body;
  if (raw === undefined) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBodyBytes) throw new RequestError(413, '查询信息过大。');
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string' && Buffer.byteLength(raw) > maxBodyBytes) {
    throw new RequestError(413, '查询信息过大。');
  }
  let body;
  try {
    body = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new RequestError(400, '查询信息不是有效的 JSON。');
  }
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    throw new RequestError(400, '查询信息不完整。');
  }
  if (Buffer.byteLength(JSON.stringify(body)) > maxBodyBytes) {
    throw new RequestError(413, '查询信息过大。');
  }
  if (!ALLOWED_ORIGINS.has(body.origin)) {
    throw new RequestError(400, '此查询接口仅支持 OpenLux 官方地址。');
  }
  return {
    body,
    token: match[1],
    origin: body.origin,
  };
}
export async function providerJSON(origin, pathname, headers = {}) {
  let response;
  try {
    response = await fetch(origin + pathname, {
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new RequestError(
      error.name === 'TimeoutError' ? 504 : 502,
      '暂时无法连接 OpenLux，请稍后刷新。',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RequestError(502, 'OpenLux 返回了空响应。');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 1024 * 1024) {
      await reader.cancel();
      throw new RequestError(502, 'OpenLux 返回的查询内容过大。');
    }
    chunks.push(Buffer.from(value));
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(502, 'OpenLux 返回了无法识别的查询内容。');
  }
  if (!response.ok || payload.success === false || payload.error) {
    const message = String(payload.message || payload.error?.message || '');
    const denied =
      [401, 403].includes(response.status) ||
      /无权|令牌|access.?token|unauthori|用户.?ID|user.?id/i.test(message);
    if (denied) throw new RequestError(401, '查询凭据未通过验证，请检查密钥与用户 ID。');
    if (response.status === 429) throw new RequestError(429, 'OpenLux 暂时限流，请稍后刷新。');
    throw new RequestError(502, 'OpenLux 查询失败，请稍后重试。');
  }
  return payload;
}
export function failure(response, error) {
  if (error.status === 405) response.setHeader('Allow', 'POST');
  sendJSON(response, error instanceof RequestError ? error.status : 502, {
    success: false,
    message: error instanceof RequestError ? error.message : '查询未完成，请稍后刷新。',
  });
}
export function numericFields(data, fields) {
  return Object.fromEntries(
    fields.map((key) => [
      key,
      typeof data[key] === 'number' && Number.isFinite(data[key]) ? data[key] : null,
    ]),
  );
}
