export async function postQuery(endpoint, origin, token, fields = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({
      origin,
      ...fields,
    }),
    signal: AbortSignal.timeout(30000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`查询返回了无法识别的内容（HTTP ${response.status}），请稍后刷新。`);
  }
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.message || `查询失败（HTTP ${response.status}）。`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
