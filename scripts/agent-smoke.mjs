// Browser integration checks. Uses an isolated profile and mocks every provider request.
// Supply Playwright through NODE_PATH when it is provided by the host runtime.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = 'test-results/agent';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let imageCalls = 0, providerAttempts = 0, mode = 'normal', lastContext, lastVariantContext, image, compileCalls = 0;
const sentPrompts = [];
await page.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === '/fixture-seed') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated test setup</title>' });
  if (url.pathname === '/api/agent') {
    const body = request.postDataJSON();
    if (body.action === 'variants') {
      compileCalls++; lastVariantContext = body.context;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (mode === 'compile-network') return route.abort('connectionreset');
      const variants = body.context.brief.variants.map((v) => ({ label: v.label, prompt: mode === 'compile-unsafe' ? '创作3张独立横版高端消费电子产品海报，不要拼成一张' : `一幅完整横版产品广告海报，保留香皂形状、Logo 和英文排版。${v.prompt}。主体清晰，排版克制。` }));
      return route.fulfill({ json: { plan: { variants }, usage: { input_tokens: 2 } } });
    }
    lastContext = body.context;
    if (body.action !== 'plan') return route.fulfill({ json: { visible: true } });
    const c = body.context;
    if (mode === 'interaction' && !c.answers.length) return route.fulfill({ json: { plan: { decision: 'clarify', summary: '先确认适合产品广告的变化方向。', questions: [{ title: '产品、Logo 和英文排版保持一致，想先比较哪类变化？', options: ['背景质感', '光线氛围', '构图留白'] }] } } });
    const roles = c.references.map((ref) => {
      const locked = c.requirements.references.find((item) => item.id === ref.id);
      return { id: ref.id, role: locked?.role || ref.role, note: locked?.note || ref.note || '' };
    });
    const p = {
      decision: 'ready', summary: '保留产品与 Logo，背景更亮。', prompt: c.request,
      constraints: c.requirements.values.constraints || '', exactText: c.requirements.values.exactText || '',
      operation: mode === 'crop' ? 'crop' : mode === 'local' ? 'local' : mode === 'outpaint' ? 'outpaint' : c.requirements.values.operation || 'create',
      baseId: c.requirements.values.baseId || '', model: 'gpt-image-2', size: mode === 'crop' || mode === 'outpaint' ? '1024x1280' : mode === 'drift' ? '1536x1024' : '1024x1024',
      count: mode === 'drift' ? 2 : ['variants', 'interaction'].includes(mode) ? 3 : 1, quality: 'medium', format: 'png', background: 'auto',
      variantAxis: ['drift', 'variants', 'interaction'].includes(mode) ? '光线' : '',
      variants: mode === 'drift' ? [{ label: '明亮', prompt: '柔和明亮光线' }, { label: '柔暗', prompt: '略微柔暗光线' }] : ['variants', 'interaction'].includes(mode) ? (c.variation.options.length ? c.variation.options : ['柔和左侧光', '正面漫射光', '轻微轮廓补光']).map((prompt, i) => ({ label: ['柔和侧光', '正面漫射', '轮廓补光'][i], prompt })) : [],
      referenceRoles: mode === 'drift' ? roles.map((ref) => ({ ...ref, role: 'style' })) : roles, questions: [],
    };
    if (['variants', 'interaction'].includes(mode)) p.prompt = '创作3张独立横版高端消费电子产品海报，不要拼成一张。保留主体与英文排版';
    if (['drift', 'variants', 'interaction'].includes(mode)) {
      p.contentType = '产品广告海报';
      p.variationSuggestions = [
        { axis: '光线', reason: '保留香皂产品与英文排版，通过光向对比产品纹理。', variants: p.variants },
        { axis: '背景', reason: '仅调整纯色背景明度，让产品继续成为主体。', variants: [{ label: '浅灰背景', prompt: '使用浅灰纯色背景' }, { label: '暖灰背景', prompt: '使用淡暖灰纯色背景' }] },
      ];
    }
    if (mode === 'aggregate') { p.count = 3; p.prompt = '创作3张独立横版高端消费电子产品海报，不要拼成一张。借鉴 Apple 广告的极简视觉语言'; }
    return route.fulfill({ json: { plan: p, usage: { input_tokens: 1 } } });
  }
  if (url.hostname === 'api.openlux.ai' && url.pathname.startsWith('/v1/images/')) {
    imageCalls++;
    providerAttempts++;
    const data = request.postData() || '';
    sentPrompts.push({ data, mode });
    if (mode === 'network') return route.abort('connectionreset');
    if (mode === 'gateway') return route.fulfill({ status: 503, json: { error: { code: 'model_not_found' } } });
    if (mode === 'limited' && providerAttempts === 1) return route.fulfill({ status: 429, headers: { 'Retry-After': '1', 'Access-Control-Expose-Headers': 'Retry-After' }, json: { error: { message: 'rate limited' } } });
    if (mode === 'reject' && providerAttempts === 1) return route.fulfill({ status: 404, json: { error: { code: 'model_not_found', message: 'model not found' } } });
    return route.fulfill({ json: { data: [{ b64_json: image }], output_format: 'png' } });
  }
  if (url.hostname !== '127.0.0.1') return route.abort();
  return route.continue();
});
const saved = () => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openlux-studio', 1); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
  const inspect = (value) => value instanceof Blob ? { size: value.size, type: value.type } : Array.isArray(value) ? value.map(inspect) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inspect(item)])) : value;
  return new Promise((resolve) => { const r = db.transaction('state').objectStore('state').get('history'); r.onsuccess = () => { db.close(); resolve(inspect(r.result)); }; });
});
const waitSaved = async (predicate) => {
  for (let i = 0; i < 400; i++) { const s = await saved(); if (predicate(s)) return s; await page.waitForTimeout(50); }
  throw new Error('Persisted state did not reach expected result');
};
async function seed() {
  await page.goto('http://127.0.0.1:4173/fixture-seed');
  await page.waitForLoadState('networkidle');
  image = await page.evaluate(async () => {
    localStorage.setItem('openlux_key', 'isolated-browser-fixture');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ebeff0'; ctx.fillRect(0, 0, 1024, 1024);
    ctx.fillStyle = '#708278'; ctx.fillRect(320, 260, 384, 480);
    ctx.fillStyle = '#fff'; ctx.font = '42px sans-serif'; ctx.fillText('SOAP', 450, 520);
    const outputBlob = await new Promise((resolve) => canvas.toBlob(resolve));
    const settings = { model: 'gpt-image-2', route: '', size: '1024x1024', quality: 'medium', format: 'png', background: 'auto', base: 'https://api.openlux.ai/v1', timeout: 300 };
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      id: `version${i}`, rootId: i === 1 ? 'version0' : `version${i}`, parentId: i === 1 ? 'version0' : null,
      prompt: `香皂产品 ${i + 1}`, settings, refs: [], constraints: 'Logo 保持原样', status: 'success', outputBlob,
      createdAt: Date.now() - i * 1000, projectId: 'default', batchId: `batch${i}`, attempts: 1,
      confirmedRequirements: { version: 1, confirmedAt: 1, values: { constraints: 'Logo 保持原样', exactText: 'Soap Kit.' }, sources: { constraints: { kind: 'user', text: 'Logo 保持原样' } }, references: [] },
    }));
    const state = { version: 3, tasks, projects: [{ id: 'default', name: '未分类' }], presets: [], assets: [], ledger: [], agentRuns: [], draft: {}, prefs: { gptCatalog: { base: settings.base, ids: ['gpt-image-2', 'gpt-image-2-fast'] }, prices: { 'gpt-image-2': 0.1, 'gpt-image-2-fast': 0.08 }, agentOptions: { maxRequests: 3, costLimit: 0.5, automatic: false, candidates: ['gpt-image-2-fast'] } } };
    const db = await new Promise((resolve) => { const r = indexedDB.open('openlux-studio', 1); r.onupgradeneeded = () => r.result.createObjectStore('state'); r.onsuccess = () => resolve(r.result); });
    await new Promise((resolve) => { const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(state, 'history'); tx.oncomplete = resolve; }); db.close();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.goto('http://127.0.0.1:4173'); await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => !document.getElementById('genBtn').disabled);
}
async function startFromVersion(request, operation = 'normal', variation = null, sourceId = 'version0') {
  mode = operation;
  providerAttempts = 0;
  if (await page.locator('#agentActivityMinimize').isVisible()) await page.locator('#agentActivityMinimize').click();
  await page.locator(`[data-task-id="${sourceId}"] .output`).click();
  await page.locator('[data-detail-action="agent"]').click();
  await page.locator('#prompt').fill(request);
  if (variation) await page.evaluate(({ axis, options }) => {
    const axisField = document.getElementById('variantAxis'); axisField.value = axis; axisField.dispatchEvent(new Event('change', { bubbles: true }));
    const lines = document.getElementById('variants'); lines.value = options.join('\n'); lines.dispatchEvent(new Event('input', { bubbles: true }));
  }, variation);
  await page.locator('#genBtn').click();
  await page.locator('#agentActivityReview').waitFor({ state: 'visible' });
  await page.locator('#agentActivityReview').click();
  await page.locator('#agentPlanDlg').waitFor({ state: 'visible' });
}
async function requestPreviews(count = 1) {
  if (!(await page.locator('#agentPlanExecutionPreview').evaluate((el) => el.open))) await page.locator('#agentPlanExecutionPreview > summary').click();
  await page.waitForFunction((n) => document.querySelectorAll('#agentPlanRequestPreview .agent-request-prompt').length === n, count);
  return page.locator('#agentPlanRequestPreview .agent-request-prompt').allTextContents();
}
async function compilePrompts() {
  const before = imageCalls;
  await page.locator('#agentExecute').click();
  await page.waitForFunction(() => document.querySelector('#agentExecute').textContent.startsWith('确认生成'));
  assert.equal(imageCalls, before, 'writing prompts must never start image generation');
}
try {
  await seed();
  await startFromVersion('背景再亮一点');
  assert.equal(lastContext.selectedVersionId, 'version0');
  assert.equal(await page.locator('#agentPlanConstraints').inputValue(), 'Logo 保持原样');
  assert.equal(await page.locator('#agentPlanExactText').inputValue(), 'Soap Kit.');
  await page.screenshot({ path: `${out}/confirm-desktop.png` });
  // Double-click at the DOM level during the same event turn, including a stale click.
  await page.locator('#agentExecute').evaluate((button) => { button.click(); button.click(); });
  let state = await waitSaved((s) => s.agentRuns[0]?.status === 'success');
  assert.equal(imageCalls, 1);
  const generated = state.tasks.find((task) => task.agentRunId === state.agentRuns[0].id);
  assert.equal(generated.parentId, 'version0');
  assert.equal(generated.approval.parentId, 'version0');
  assert.equal(generated.confirmedRequirements.values.constraints, 'Logo 保持原样');
  assert.equal(generated.outputCheck.actual.width, 1024);
  assert.equal(generated.outputCheck.visualStatus, 'unchecked');
  // A01 deliberately disagree with the user: no requests until the diff is acknowledged.
  await startFromVersion('1 张正方形主图，Logo 保持原样', 'drift');
  assert.match(await page.locator('#agentPlanDifferences').innerText(), /张数/);
  assert.equal(await page.locator('#agentExecute').isDisabled(), true);
  await page.locator('#agentPlanVariants input[type=checkbox]').first().check();
  await compilePrompts();
  await page.locator('#agentExecute').click();
  assert.match(await page.locator('#agentPlanError').innerText(), /核对/);
  assert.equal(imageCalls, 1);
  assert.equal(await page.locator('#agentPlanCount').inputValue(), '1');
  await page.locator('label[for="agentPlanSize"]').click();
  await page.getByRole('option', { name: '1024x1024', exact: true }).click();
  await page.locator('#agentPlanAcknowledge').check();
  await page.locator('#agentPlanConstraints').fill('Logo 保持原样。保留材质。');
  assert.equal(await page.locator('#agentPlanAcknowledge').isChecked(), false);
  // Closing and reopening restores the same form, then switch sessions from history.
  await page.locator('[data-close="agentPlanDlg"]').click();
  await page.locator('#agentActivityMinimize').click();
  const layout = await page.locator('#gallery').evaluate((el) => ({ width: el.clientWidth, top: el.getBoundingClientRect().top }));
  await page.locator('#agentActivityBtn').click();
  assert.deepEqual(await page.locator('#gallery').evaluate((el) => ({ width: el.clientWidth, top: el.getBoundingClientRect().top })), layout);
  await page.locator('#agentActivityMinimize').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#agentActivityBtn').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#agentActivityBtn').evaluate((el) => el === document.activeElement), true);
  await page.locator('#agentActivityBtn').click();
  await page.locator('#agentActivityReview').click();
  assert.equal(await page.locator('#agentPlanConstraints').inputValue(), 'Logo 保持原样。保留材质。');
  await page.locator('[data-close="agentPlanDlg"]').click();
  // Stop this pending plan so a new task opens independently.
  await page.locator('#agentActivity [data-agent-action="stop"]').click();
  await startFromVersion('裁切为 4:5，Logo 保持原样', 'crop');
  await page.locator('#agentExecute').click();
  await page.locator('#editorDlg').waitFor({ state: 'visible' });
  await page.screenshot({ path: `${out}/crop-preview.png` });
  await page.locator('#applyEditor').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'success' && s.tasks[0]?.operation === 'crop');
  assert.equal(imageCalls, 1);
  assert.equal(state.tasks[0].parentId, 'version0');
  assert.equal(state.tasks[0].outputCheck.actual.height, 1280);
  assert.equal(state.tasks[0].priceEstimate, 0);
  // Local editor configuration is isolated from the next composer's text.
  await startFromVersion('只去除表面弯曲纹理', 'local');
  await page.locator('#agentExecute').click();
  assert.match(await page.locator('#agentPlanError').innerText(), /划选/);
  await page.locator('#agentPrepareOperation').click();
  const canvas = await page.locator('#editorCanvas').boundingBox();
  await page.mouse.move(canvas.x + canvas.width * 0.45, canvas.y + canvas.height * 0.45);
  await page.mouse.down(); await page.mouse.move(canvas.x + canvas.width * 0.55, canvas.y + canvas.height * 0.55); await page.mouse.up();
  await page.locator('#applyEditor').click();
  await page.locator('#agentPlanDlg').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#agentPlanFormat').inputValue(), 'png');
  // Responsive viewports: all overflow stays inside its panel; dialog actions remain visible.
  const checks = [];
  for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [390, 844], [320, 568], [812, 375]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `${out}/confirm-${width}.png` });
    const actual = await page.evaluate(() => {
      const dlg = document.getElementById('agentPlanDlg'), action = document.getElementById('agentExecute').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, dialogOverflow: dlg.scrollWidth > dlg.clientWidth + 1, actionVisible: action.top >= 0 && action.bottom <= innerHeight + 1 };
    });
    assert.equal(actual.overflow, false, `page overflow at ${width}`);
    assert.equal(actual.dialogOverflow, false, `dialog overflow at ${width}`);
    assert.equal(actual.actionVisible, true, `action out of view at ${width}`);
    checks.push({ width, height, ...actual });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const [localPreview] = await requestPreviews();
  assert.ok(localPreview.includes('Edit only the'));
  if (await page.locator('#agentPlanAcknowledge').isVisible()) await page.locator('#agentPlanAcknowledge').check();
  await page.locator('#agentExecute').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'success');
  assert.equal(state.tasks[0].submittedPrompt, localPreview);
  assert.equal(imageCalls, 2);
  // Outpaint does not submit until the user confirms a layout and preservation policy.
  await startFromVersion('扩图为 4:5，保留产品和 Logo', 'outpaint', null, 'version1');
  await page.locator('#agentExecute').click();
  assert.match(await page.locator('#agentPlanError').innerText(), /方向|核对/);
  await page.locator('#agentPrepareOperation').click();
  await page.locator('#applyEditor').click();
  await page.locator('#agentPlanDlg').waitFor({ state: 'visible' });
  state = await saved();
  assert.equal(state.agentRuns[0].snapshot.mask.kind, 'outpaint');
  assert.equal(state.agentRuns[0].snapshot.mask.originalBlob.size > 0, true);
  const [outpaintPreview] = await requestPreviews();
  if (await page.locator('#agentPlanAcknowledge').isVisible()) await page.locator('#agentPlanAcknowledge').check();
  await page.locator('#agentExecute').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'success');
  assert.equal(imageCalls, 3);
  assert.equal(state.tasks[0].operation, 'outpaint');
  assert.equal(state.tasks[0].submittedPrompt, outpaintPreview);
  assert.equal(state.tasks[0].outputCheck.issues.length > 0, true); // square provider result is flagged
  // High-detail planning crops remain linked to their source and never replace originals.
  await startFromVersion('背景再亮一点');
  await page.locator('[data-detail-reference]').click();
  await page.locator('#applyEditor').click();
  await page.locator('#agentActivityReview').waitFor({ state: 'visible' });
  state = await waitSaved((s) => s.agentRuns[0]?.detailReferences?.length === 1 && s.agentRuns[0].status === 'review' && s.agentRuns[0].planningUsage?.length >= 2);
  assert.equal(state.agentRuns[0].detailReferences[0].parentId, state.agentRuns[0].snapshot.refs[0].id);
  assert.equal(lastContext.detailReferences.length, 1);
  assert.equal(imageCalls, 3);
  await page.locator('#agentActivity [data-agent-action="stop"]').click();
  await startFromVersion('背景再亮一点', 'limited');
  await page.locator('#agentExecute').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'success');
  assert.equal(state.agentRuns[0].requests, 2);
  assert.equal(state.agentRuns[0].usedEstimate, 0.2);
  await startFromVersion('背景再亮一点', 'reject');
  await page.locator('#agentExecute').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'success');
  assert.equal(state.agentRuns[0].requests, 2);
  assert.equal(state.tasks[0].settings.model, 'gpt-image-2-fast');
  assert.equal(state.agentRuns[0].usedEstimate <= 0.5, true);
  await startFromVersion('背景再亮一点', 'gateway');
  await page.locator('#agentExecute').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'unknown');
  assert.equal(state.agentRuns[0].requests, 1);
  // Ambiguous network failures never create a retry, and refresh preserves verification.
  await startFromVersion('背景再亮一点', 'network');
  await page.locator('#agentExecute').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'unknown');
  const callsAtFailure = imageCalls;
  await page.reload(); await page.waitForLoadState('networkidle');
  state = await saved();
  assert.equal(imageCalls, callsAtFailure);
  assert.equal(state.agentRuns[0].status, 'unknown');
  // Import a pre-Agent backup through the real merge flow, then continue its old work.
  const legacyBackup = { version: 3, projects: [{ id: 'default', name: '未分类' }], presets: [], assets: [], ledger: [], tasks: [{
    id: 'legacy-restore', prompt: '旧版香皂作品', projectId: 'default', status: 'success', createdAt: Date.now(),
    settings: { model: 'gpt-image-2', route: '', size: '1024x1024', quality: 'medium', format: 'png', background: 'auto', base: 'https://api.openlux.ai/v1', timeout: 300 },
    refs: [], outputBlob: { __openlux_blob: `data:image/png;base64,${image}`, type: 'image/png' },
  }] };
  await page.locator('#backupInput').setInputFiles({ name: 'legacy-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacyBackup)) });
  await page.locator('#confirmClear').click();
  await waitSaved((s) => s.tasks.some((t) => t.id === 'legacy-restore'));
  mode = 'normal';
  await page.locator('[data-task-id="legacy-restore"] .output').click();
  await page.locator('[data-detail-action="agent"]').click();
  await page.locator('#prompt').fill('背景亮一点');
  await page.locator('#genBtn').click();
  await page.locator('#agentActivityReview').click();
  assert.match(await page.locator('#agentPlanDifferences').innerText(), /旧作品/);
  assert.equal(await page.locator('#agentPlanAcknowledge').isVisible(), true);
  assert.equal(imageCalls, callsAtFailure);
  await page.locator('[data-close="agentPlanDlg"]').click();
  await page.locator('#agentActivity [data-agent-action="stop"]').click();
  // Regression: one common brief plus one delta per paid request, never the whole batch.
  const choices = ['柔和左侧光', '正面漫射光', '轻微轮廓补光'];
  await startFromVersion('保留 Logo，做三张光线变体', 'variants', { axis: '光线', options: choices });
  assert.equal(lastContext.variation.axis, '光线');
  assert.deepEqual(lastContext.variation.options, choices);
  assert.equal(await page.locator('#agentPlanVariants .agent-variant').count(), 3);
  assert.match(await page.locator('#agentPlanSuggestionType').innerText(), /产品广告海报/);
  assert.match(await page.locator('#agentPlanSuggestionReason').innerText(), /纹理/);
  assert.equal(await page.locator('#agentExecute').isDisabled(), true);
  assert.equal(imageCalls, callsAtFailure);
  await page.locator('#agentPlanDlg .preset-dialog-body').evaluate((el) => { el.scrollTop = 0; });
  await page.screenshot({ path: `${out}/variant-recommendations.png` });
  await page.locator('[data-variation-group="1"]').click();
  assert.match(await page.locator('#agentPlanSuggestionReason').innerText(), /背景明度/);
  await page.locator('#agentPlanVariants input[type=checkbox]').first().check();
  assert.equal(await page.locator('#agentPlanCount').inputValue(), '1');
  await page.locator('[data-variation-group="0"]').click();
  assert.equal(await page.locator('#agentPlanCount').inputValue(), '0');
  assert.equal(await page.locator('#agentExecute').isDisabled(), true);
  for (const box of await page.locator('#agentPlanVariants input[type=checkbox]').all()) await box.check();
  await page.locator('#agentPlanStyleNotes').fill('光线变化明显一点，产品与英文文案不变');
  await compilePrompts();
  assert.equal(lastVariantContext.brief.styleNotes, '光线变化明显一点，产品与英文文案不变');
  assert.equal(lastVariantContext.brief.variants.length, 3);
  const compiledPrompts = await page.locator('#agentCompiledVariants textarea').evaluateAll((inputs) => inputs.map((input) => input.value));
  await requestPreviews(3);
  assert.match(await page.locator('#agentPlanRequestPreview').textContent(), /3 个请求，每个请求 n=1/);
  const previewPrompts = await page.locator('#agentPlanRequestPreview .agent-request-prompt').allTextContents();
  previewPrompts.forEach((prompt, i) => {
    assert.ok(prompt.includes(choices[i]));
    choices.forEach((other, j) => { if (i !== j) assert.ok(!prompt.includes(other)); });
  });
  await page.locator('#agentPlanVariation').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${out}/variants-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#agentPlanVariation').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${out}/variants-mobile.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  const callsBeforeVariants = imageCalls;
  await page.locator('#agentExecute').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'success');
  const variantRun = state.agentRuns[0];
  const variantTasks = state.tasks.filter((task) => task.agentRunId === variantRun.id).sort((a, b) => a.variantIndex - b.variantIndex);
  assert.equal(imageCalls - callsBeforeVariants, 3);
  assert.equal(variantTasks.length, 3);
  variantTasks.forEach((task, i) => {
    assert.equal(task.variant, '');
    assert.equal(task.prompt, compiledPrompts[i]);
    assert.equal(task.variantPromptMode, 'complete');
    assert.equal(task.submittedPrompt, previewPrompts[i]);
    assert.equal(task.requestSummary.n, 1);
    assert.ok(!task.submittedPrompt.includes('生成三张'));
    assert.ok(sentPrompts.filter((item) => item.mode === 'variants').some((item) => item.data.includes(choices[i])));
    const record = variantRun.requestLog.find((item) => item.taskId === task.id);
    assert.equal(record.prompt, task.submittedPrompt);
    assert.equal(record.variantLabel, task.variantLabel);
    assert.equal(record.request.n, 1);
  });
  await page.locator('#agentActivityBtn').click();
  if (!(await page.locator('#agentHistoryDlg').isVisible())) await page.locator('#agentActivityHistory').click();
  const record = page.locator(`#agentHistoryList [data-agent-run="${variantRun.id}"]`);
  await record.locator('[data-agent-action="import"]').click();
  assert.equal(await page.locator('#agentHistoryDlg').isVisible(), false);
  assert.equal(await page.locator('#n').inputValue(), '1');
  assert.equal(await page.locator('#variantAxis').inputValue(), '光线');
  assert.equal(await page.locator('#variantPromptMode').inputValue(), 'complete');
  assert.equal(await page.locator('#exactText').inputValue(), 'Soap Kit.');
  assert.deepEqual((await page.locator('#variants').inputValue()).split('\n'), compiledPrompts);
  assert.ok(!(await page.locator('#prompt').inputValue()).includes('生成三张'));
  await page.locator('#agentModeBtn').click();
  await page.locator('#agentSettingsBtn').click();
  await page.locator('#agentAutomatic').check();
  await page.locator('#agentSettingsForm button[type=submit]').click();
  await startFromVersion('保留 Logo，推荐光线变体', 'variants', { axis: '光线', options: choices });
  state = await saved();
  assert.match(state.agentRuns[0].error, /选择/);
  assert.equal(imageCalls, callsBeforeVariants + 3);
  await page.locator('[data-variation-group="1"]').click();
  await page.locator('#agentPlanVariants input[type=checkbox]').last().check();
  assert.equal(await page.locator('#agentPlanCount').inputValue(), '1');
  await page.locator('[data-close="agentPlanDlg"]').click();
  await page.locator('#agentActivityReview').click();
  assert.equal(await page.locator('#agentPlanVariants input[type=checkbox]').last().isChecked(), true);
  assert.equal(await page.locator('#agentPlanCount').inputValue(), '1');
  await compilePrompts();
  if (await page.locator('#agentPlanAcknowledge').isVisible()) await page.locator('#agentPlanAcknowledge').check();
  await page.locator('#agentExecute').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'success');
  const chosenTasks = state.tasks.filter((task) => task.agentRunId === state.agentRuns[0].id);
  assert.equal(chosenTasks.length, 1);
  assert.ok(chosenTasks[0].prompt.includes('使用淡暖灰纯色背景'));
  assert.equal(chosenTasks[0].variantAxis, '背景');
  assert.equal(imageCalls, callsBeforeVariants + 4);
  // Old or malformed planner output is stopped with a reason; zero image requests.
  mode = 'aggregate';
  if (await page.locator('#agentActivityMinimize').isVisible()) await page.locator('#agentActivityMinimize').click();
  await page.locator('[data-task-id="version0"] .output').click();
  await page.locator('[data-detail-action="agent"]').click();
  await page.locator('#prompt').fill('做三张变体');
  await page.locator('#genBtn').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'failed');
  assert.match(state.agentRuns[0].error, /整批/);
  assert.equal(imageCalls, callsBeforeVariants + 4);
  // Open-ended interaction: ask about style, accept free feedback, then compile without generating.
  await startFromVersion('帮我推荐适合这个产品的变体，我来选择', 'interaction');
  assert.equal(await page.locator('#agentQuestions fieldset').count(), 1);
  await page.locator('#agentQuestions input[type=radio]').first().check();
  await page.locator('#agentExecute').click();
  await page.locator('#agentActivityReview').click();
  assert.equal(lastContext.answers[0].answer, '背景质感');
  await page.locator('#agentPlanStyleNotes').fill('背景改为更有质感的灰色，产品和英文排版保持一致');
  await page.locator('#agentReviseVariants').click();
  await page.locator('#agentPlanDlg').waitFor({ state: 'visible' });
  assert.ok(lastContext.variationFeedback.includes('质感的灰色'));
  assert.ok(lastContext.priorPlan.prompt.includes('创作3张'));
  await page.locator('[data-variation-group="1"]').click();
  await page.locator('#agentPlanVariants input[type=checkbox]').first().check();
  await compilePrompts();
  const beforeInvalid = imageCalls;
  // Altering the brief invalidates the compilation; a bad model reply never falls back to it.
  await page.locator('#agentPlanStyleNotes').fill('更温暖的背景，产品保持不变');
  assert.match(await page.locator('#agentExecute').innerText(), /编写/);
  assert.equal(await page.locator('#agentCompiledVariants textarea').first().isDisabled(), true);
  mode = 'compile-unsafe';
  await page.locator('#agentExecute').click();
  await page.waitForFunction(() => document.querySelector('#agentPlanError').textContent.includes('整批'));
  assert.equal(imageCalls, beforeInvalid);
  assert.equal(await page.locator('#agentCompiledSection').isVisible(), false);
  mode = 'compile-network';
  await page.locator('#agentExecute').click();
  await page.waitForFunction(() => !document.querySelector('#agentExecute').disabled && !!document.querySelector('#agentPlanError').textContent);
  assert.equal(imageCalls, beforeInvalid);
  mode = 'variants';
  const compileBeforeDouble = compileCalls;
  await page.locator('#agentExecute').evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector('#agentExecute').textContent.startsWith('确认生成'));
  assert.equal(compileCalls, compileBeforeDouble + 1);
  const full = page.locator('#agentCompiledVariants textarea').first();
  const safePrompt = await full.inputValue();
  await full.fill('创作3张独立横版高端消费电子产品海报，不要拼成一张');
  await page.locator('#agentExecute').click();
  assert.match(await page.locator('#agentPlanError').innerText(), /整批/);
  assert.equal(imageCalls, beforeInvalid);
  await full.fill(safePrompt + ' 留白稍多。');
  const [finalPreview] = await requestPreviews();
  await page.screenshot({ path: `${out}/independent-prompts-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#agentCompiledSection').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${out}/independent-prompts-mobile.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  if (await page.locator('#agentPlanAcknowledge').isVisible()) await page.locator('#agentPlanAcknowledge').check();
  await page.locator('#agentExecute').click();
  state = await waitSaved((s) => s.agentRuns[0]?.status === 'success');
  assert.equal(imageCalls, beforeInvalid + 1);
  assert.equal(state.tasks[0].submittedPrompt, finalPreview);
  assert.ok(!state.tasks[0].prompt.includes('创作3张'));
  // Import keeps independent prompts and exact copy; even a batch instruction in the shared box is not sent.
  const finalRunId = state.agentRuns[0].id;
  await page.locator('#agentActivityBtn').click();
  if (!(await page.locator('#agentHistoryDlg').isVisible())) await page.locator('#agentActivityHistory').click();
  await page.locator(`#agentHistoryList [data-agent-run="${finalRunId}"] [data-agent-action="import"]`).click();
  await page.locator('#prompt').fill('创作3张独立横版高端消费电子产品海报，不要拼成一张');
  assert.equal(await page.locator('#variantPromptMode').inputValue(), 'complete');
  const beforeManual = imageCalls;
  await page.locator('#genBtn').click();
  state = await waitSaved((s) => !s.tasks[0].agentRunId && s.tasks[0].status === 'success');
  assert.equal(imageCalls, beforeManual + 1);
  assert.ok(!state.tasks[0].submittedPrompt.includes('创作3张'));
  assert.ok(state.tasks[0].submittedPrompt.includes('Soap Kit.'));
  // Last-mile validation also checks appended constraints, before any provider request.
  await page.locator('#constraints').evaluate((input) => { input.value = '创作3张独立横版产品海报'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#genBtn').click();
  state = await waitSaved((s) => !s.tasks[0].agentRunId && s.tasks[0].status === 'failed');
  assert.match(state.tasks[0].error, /整批/);
  assert.equal(imageCalls, beforeManual + 1);
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(`${out}/report.json`, JSON.stringify({ imageCalls, compileCalls, errors, checks, passed: ['version lineage', 'fixed approval', 'single double-click submission', 'intent conflict gate', 'confirmation invalidation', 'retained form', 'stable gallery layout', 'keyboard collapse and focus', 'zero-request crop', 'mask workflow', 'responsive dialog', 'outpaint layout and output mismatch', 'high-detail reference planning', '429 shared budget', 'explicit rejection fallback', 'ambiguous 503 no retry', 'network failure and refresh', 'legacy backup import and continuation', 'isolated variant prompts', 'preview matches actual requests', 'screenshot batch instruction blocked', 'manual import keeps one image per variant', 'content-aware recommendations require selection', 'one selected suggestion produces one image', 'mask and outpaint preview matches request', 'automatic mode waits for variant selection', 'style clarification and follow-up feedback', 'independent AI prompt writing before images', 'source edits invalidate old prompts', 'unsafe compilation fails closed', 'compiler network failure does not generate', 'double click compiles once', 'edited final prompt is validated', 'complete manual mode preserves exact copy', 'last-mile constraints validation'] }, null, 2));
  console.log('Browser integration passed, including isolated variant prompts and request transparency; all provider responses mocked.');
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` });
  console.error('Browser state:', await page.locator('body').innerText(), errors);
  throw error;
} finally { await browser.close(); }
