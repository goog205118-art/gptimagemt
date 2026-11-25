// Isolated browser checks; provider requests are intercepted and never billed.
// Run a Vite dev server first. Playwright may be supplied through NODE_PATH.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const origin = process.env.SMOKE_ORIGIN || 'http://127.0.0.1:5173';
const out = 'test-results/image-size';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [], requests = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === origin) {
    if (url.pathname.startsWith('/api/')) throw new Error('Unexpected local provider proxy request');
    return route.continue();
  }
  if (url.pathname === '/v1/images/generations') {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { data: [{ b64_json: await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
      canvas.getContext('2d').fillRect(0, 0, 32, 32);
      return canvas.toDataURL().split(',')[1];
    }) }] } });
  }
  throw new Error(`Unexpected external request to ${url.origin}${url.pathname}`);
});
await page.addInitScript(() => localStorage.setItem('openlux_key', 'isolated-image-size-fixture'));
async function openSettings() {
  await page.locator('#composerPeek').dispatchEvent('click');
  await page.locator('#advancedToggle').click();
  assert.equal(await page.locator('#customSizeControls').evaluate((element) => element.tagName), 'DIV');
  assert.equal(await page.locator('#customWidth').isVisible(), true);
}
async function sizeValue() { return page.locator('#size').inputValue(); }
async function setDimensions(width, height) {
  await page.locator('#customWidth').fill(String(width));
  await page.locator('#customHeight').fill(String(height));
}
try {
  await page.goto(origin);
  await page.waitForFunction(() => !document.getElementById('genBtn').disabled);
  await openSettings();
  await setDimensions(2000, 2000);
  assert.equal(await sizeValue(), '2000x2000');
  assert.equal(await page.locator('#sizeFeedback').textContent(), '');
  assert.equal(await page.locator('#genBtn').isDisabled(), false);
  for (const [width, height, reason] of [[1920, 1080, /16/], [4000, 1024, /3840/], [512, 512, /655,360/], [3072, 3072, /8,294,400/], [2048, 640, /3:1/], [0, 0, /大于 0/]]) {
    await setDimensions(width, height);
    assert.equal(await page.locator('#genBtn').isDisabled(), true);
    assert.match(await page.locator('#sizeFeedback').innerText(), reason);
    assert.equal(await sizeValue(), `${width}x${height}`);
  }
  await page.locator('#customWidth').fill('');
  assert.equal(await page.locator('#genBtn').isDisabled(), true);
  assert.equal(await page.locator('#customWidth').inputValue(), '');
  await page.locator('#customRatioWidth').fill('16');
  await page.locator('#customRatioHeight').fill('9');
  await page.locator('#customLongEdge').fill('2048');
  await page.locator('#calculateSize').click();
  assert.equal(await sizeValue(), '2048x1152');
  assert.equal(await page.locator('#sizeFeedback').textContent(), '');
  assert.equal(await page.locator('#customWidth').inputValue(), '2048');
  await page.locator('#customRatioWidth').fill('2.35');
  await page.locator('#customRatioHeight').fill('1');
  await page.locator('#calculateSize').click();
  const fractional = await sizeValue();
  await page.locator('#customRatioWidth').fill('4');
  await page.locator('#calculateSize').click();
  assert.equal(await sizeValue(), fractional);
  assert.match(await page.locator('#sizeFeedback').innerText(), /1:3.*3:1/);
  await setDimensions(2000, 2000);
  await page.locator('#prompt').fill('一幅产品摄影');
  // Native select change follows the same path as selecting a model in the picker.
  await page.evaluate(() => {
    const select = document.getElementById('model'); select.value = 'gpt-image-1.5';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await sizeValue(), '2000x2000');
  assert.equal(await page.locator('#customWidth').isDisabled(), true);
  assert.equal(await page.locator('#genBtn').isDisabled(), true);
  assert.match(await page.locator('#sizeFeedback').innerText(), /当前模型仅支持/);
  await page.evaluate(() => {
    const select = document.getElementById('model'); select.value = 'gpt-image-2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await page.locator('#genBtn').isDisabled(), false);
  await page.locator('#parameterClose').click();
  await page.locator('#genBtn').click();
  await page.waitForFunction(() => document.querySelector('[data-output]'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].size, '2000x2000');
  assert.equal(requests[0].n, 1);
  const integration = await page.evaluate(async () => {
    const { prepareGptRequest } = await import('/src/services/images.js');
    const { state } = await import('/src/core/state.js');
    const { applySettings, updateSend, flushDraft } = await import('/src/features/composer.js');
    const task = { ...state.tasks[0], effectivePrompt: '一幅产品摄影', mask: null };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const edited = await prepareGptRequest({ ...task, refs: [{ id: 'ref', name: 'ref.png', blob }] });
    const failures = [];
    for (const size of ['1920x1080', '4096x4096', '512x512']) {
      try { await prepareGptRequest({ ...task, refs: [], settings: { ...task.settings, size } }); }
      catch (error) { failures.push(error.message); }
    }
    applySettings({ ...task.settings, size: '1920x1080' }); updateSend();
    const importedBlocked = document.getElementById('genBtn').disabled;
    applySettings({ ...task.settings, size: '1536x864' }); updateSend();
    await flushDraft();
    return { path: edited.path, size: edited.body.get('size'), failures, importedBlocked };
  });
  assert.equal(integration.path, '/images/edits');
  assert.equal(integration.size, '2000x2000');
  assert.equal(integration.failures.length, 3);
  assert.equal(integration.importedBlocked, true);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('genBtn').disabled);
  assert.equal(await sizeValue(), '1536x864');
  assert.equal(requests.length, 1);
  await openSettings();
  await page.screenshot({ path: `${out}/desktop.png` });
  for (const [width, height, name] of [[390, 844, 'mobile'], [320, 640, 'narrow'], [844, 390, 'landscape']]) {
    await page.setViewportSize({ width, height });
    await page.locator('#calculateSize').scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => {
      const panel = document.getElementById('advanced'), body = panel.querySelector('.parameter-body');
      return { page: document.documentElement.scrollWidth > innerWidth, panel: body.scrollWidth > body.clientWidth + 1 };
    });
    assert.deepEqual(overflow, { page: false, panel: false });
    await page.screenshot({ path: `${out}/${name}.png` });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ passed: true, requests: requests.length, integration, fractional, errors }, null, 2));
  console.log('Custom size browser checks passed: input, ratio conversion, model change, request guards, JSON/FormData, persistence and responsive layout. All provider requests mocked.');
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` });
  console.error(await page.locator('body').innerText(), errors);
  throw error;
} finally { await browser.close(); }
