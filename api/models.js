import { readRequest, providerJSON, sendJSON, failure, RequestError } from '../server/openlux.js';
import { isGptImageModel } from '../shared/model-ids.js';
export default async function models(request, response) {
  try {
    const { token, origin } = await readRequest(request);
    const payload = await providerJSON(origin, '/v1/models', {
      Authorization: 'Bearer ' + token,
    });
    if (!Array.isArray(payload.data)) throw new RequestError(502, 'OpenLux 未返回模型列表。');
    const all = payload.data.map((model) => model?.id).filter((id) => typeof id === 'string');
    const ids = [...new Set(all.filter(isGptImageModel))];
    sendJSON(response, 200, {
      data: ids.map((id) => ({
        id,
      })),
      filtered_count: all.length - ids.length,
    });
  } catch (error) {
    failure(response, error);
  }
}
