import {
  readRequest,
  providerJSON,
  sendJSON,
  failure,
  RequestError,
  numericFields,
} from '../server/openlux.js';
export default async function quota(request, response) {
  try {
    const { body, token, origin } = await readRequest(request);
    if (!['account', 'key'].includes(body.mode))
      throw new RequestError(400, '请选择账户余额或 Key 额度。');
    const account = body.mode === 'account';
    if (account && (typeof body.userId !== 'string' || !/^\d{1,20}$/.test(body.userId))) {
      throw new RequestError(400, '请输入数字用户 ID。');
    }
    const headers = {
      Authorization: 'Bearer ' + token,
    };
    if (account) headers['New-Api-User'] = body.userId;
    const unitsPromise = providerJSON(origin, '/api/status').catch(() => null);
    const payload = await providerJSON(
      origin,
      account ? '/api/user/self' : '/api/usage/token/',
      headers,
    );
    if (!payload.data || typeof payload.data !== 'object')
      throw new RequestError(502, 'OpenLux 未返回有效额度。');
    const data = numericFields(
      payload.data,
      account
        ? ['quota', 'used_quota']
        : ['total_available', 'total_used', 'total_granted', 'expires_at'],
    );
    if (!account) data.unlimited_quota = payload.data.unlimited_quota === true;
    if (account && data.quota === null)
      throw new RequestError(502, 'OpenLux 未返回有效的账户余额。');
    const units = (await unitsPromise)?.data?.quota_per_unit;
    sendJSON(response, 200, {
      success: true,
      data,
      quota_per_unit: typeof units === 'number' && units > 0 ? units : null,
    });
  } catch (error) {
    failure(response, error);
  }
}
