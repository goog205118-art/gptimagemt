import { readRequest, providerJSON, sendJSON, failure, RequestError } from '../server/openlux.js';
import { buildPlannerBody, buildVariantPromptBody, extractPlanOutput, normalizePlan } from '../shared/agent-protocol.js';
import { normalizeCompiledVariants } from '../shared/agent-variants.js';

export default async function agent(request, response) {
  try {
    const { token, origin, body } = await readRequest(request, 3 * 1024 * 1024);
    if (body.action === 'models') {
      const data = await providerJSON(origin, '/v1/models', { Authorization: 'Bearer ' + token });
      sendJSON(response, 200, {
        visible: Array.isArray(data.data) && data.data.some((m) => m.id === body.model),
      });
      return;
    }
    if (!['plan', 'variants'].includes(body.action)) throw new RequestError(400, '未知的 Agent 操作。');
    let input;
    try {
      if (body.action === 'variants') normalizeCompiledVariants({ variants: body.context?.brief?.variants }, body.context || {});
      input = body.action === 'variants' ? buildVariantPromptBody(body) : buildPlannerBody(body);
    } catch (e) {
      throw new RequestError(400, e.message);
    }
    let upstream;
    try {
      upstream = await fetch(origin + '/v1/responses', {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(105000),
      });
    } catch {
      throw new RequestError(504, '规划等待中断，可能已产生文本用量；不会自动重新请求。');
    }
    const raw = await upstream.text();
    if (raw.length > 1024 * 1024) throw new RequestError(502, '规划响应过大。');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new RequestError(502, 'OpenLux 未返回有效 JSON。');
    }
    if (!upstream.ok || data.error) {
      const hint =
        upstream.status === 401 || upstream.status === 403
          ? '请检查 Agent Key 权限。'
          : upstream.status === 429
            ? '请求限流，请稍后手动重试。'
            : upstream.status === 400 || upstream.status === 404
              ? '请检查模型 ID、Responses 支持和结构化输出兼容方式。'
              : '请检查服务商记录，确认后再手动重试。';
      throw new RequestError(
        upstream.ok ? 502 : upstream.status,
        `OpenLux 规划请求失败（HTTP ${upstream.status}）。${hint}`,
      );
    }
    let plan;
    try {
      plan = extractPlanOutput(data);
      if (body.action === 'variants') plan = { variants: normalizeCompiledVariants(plan, body.context) };
      else normalizePlan(plan, body.context);
    } catch (e) {
      throw new RequestError(502, e.message);
    }
    sendJSON(response, 200, { plan, usage: data.usage || null });
  } catch (error) {
    failure(response, error);
  }
}
