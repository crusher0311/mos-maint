const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('../artifacts/detect-dog-workflow/node_modules/playwright');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
test('Shopmonkey branded controls, gestures, toolbar replacement and stale clicks', async () => {
  const browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      const file = path === '/' ? 'tests/browser/shopmonkey-buttons.html' : path.slice(1);
      if (!file.startsWith('mos-tools-extension/') && path !== '/') return route.abort();
      route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'text/html' });
    });
    await page.goto('https://fixture.test/');
    const controls = page.locator('#mos-shopmonkey-actions button');
    assert.equal(await controls.count(), 2);
    assert.ok((await controls.nth(1).boundingBox()).height >= 32);
    assert.equal(await controls.nth(1).locator('img').evaluate(img => img.naturalWidth > 0), true);
    await controls.nth(0).click();
    await page.getByText('Detect Dog side panel requested.').waitFor();
    await controls.nth(1).click({ button: 'right' });
    await page.getByText('Print tab requested — nothing was printed.').waitFor();
    await page.evaluate(() => {
      window.oldControl = document.querySelector('#mos-shopmonkey-actions button');
      const toolbar = document.querySelector('.toolbar');
      const old = document.querySelector('.actions');
      const replacement = document.createElement('div');
      replacement.className = 'actions';
      replacement.appendChild(toolbar);
      old.replaceWith(replacement);
      controller.update();
      document.getElementById('action').textContent = '';
      oldControl.click();
    });
    assert.equal(await controls.count(), 2);
    assert.equal(await page.locator('#action').textContent(), '');
    await page.evaluate(() => { ctx.shopId = 'another-location'; oldControl.click(); });
    assert.equal(await page.locator('#action').textContent(), '');
    assert.equal(await page.locator('button[title="Print"]').count(), 1);
  } finally { await browser.close(); }
});

test('production Shopmonkey left-click retrieves config, generates and checks the originating order before printing', async () => {
  const vm = require('node:vm');
  const { createStickerLocationRequest } = await import('../mos-tools-extension/lib/sticker-location-session.js');
  const browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const order = '04c4dad9-c97c-41b2-9ac9-85db074de4b8';
    const shop = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const calls = [];
    let navigateDuringGeneration = false;
    const deps = {
      identity: () => ({ token: 'explicit-root', apiUrl: 'https://mos.test', epoch: 1 }),
      getTab: async () => ({ url: page.url() }),
      getContext: () => page.evaluate(() => detectContext()),
      fetch: async (url, options) => {
        const u = new URL(url);
        calls.push(u.pathname + u.search);
        if (u.pathname.endsWith('/switch-location')) {
          const body = JSON.parse(options.body);
          assert.equal(body.provider, 'shopmonkey');
          return Response.json({ token: 'shopmonkey-child', ...body });
        }
        assert.equal(options.headers.Authorization, 'Bearer shopmonkey-child');
        if (!options.method) {
          // This assertion reproduces the former provider=tekmetric regression.
          assert.equal(u.searchParams.get('provider'), 'shopmonkey');
          assert.equal(u.searchParams.get('shopId'), shop);
          return Response.json({ config: { defaultOilType: 'synthetic', intervals: {} } });
        }
        const body = JSON.parse(options.body);
        assert.equal(body.provider, 'shopmonkey');
        assert.equal(body.smsShopId, shop);
        assert.equal(body.workOrderId, order);
        if (navigateDuringGeneration) {
          await page.evaluate(() => history.replaceState({}, '', '/orders/new-order'));
        }
        return Response.json({ success: true, sticker: { size: '2x2',
          dataUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>') } });
      },
    };
    const sandbox = {
      console, crypto: require('node:crypto').webcrypto, AbortController, setTimeout, clearTimeout,
      _stateReady: Promise.resolve(), mosAuthSource: 'explicit', mosApiToken: 'explicit-root',
      stickerLocationRequest: context => createStickerLocationRequest(context, deps),
      MosStickerViscosity: { extract: () => '' },
      resolveLeftClickOilType: () => 'synthetic',
    };
    vm.createContext(sandbox);
    const background = fs.readFileSync('mos-tools-extension/background.js', 'utf8');
    vm.runInContext(background.slice(background.indexOf('const pendingImmediateStickerActions ='), background.indexOf('// ==================== LABOR RATE RULES')), sandbox);
    await page.exposeFunction('immediatePrint', async context => {
      try { return await sandbox.handleImmediateStickerPrint(context, 1); }
      catch (error) { return { success: false, error: error.message }; }
    });
    await page.route('**/*', route => {
      if (!route.request().isNavigationRequest()) return route.abort();
      const html = fs.readFileSync('tests/browser/shopmonkey-buttons.html', 'utf8').split('<script')[0] +
        '<p>VIN: 1FT8W3BT0BEA08647</p><p>Mileage: 119,067</p>';
      return route.fulfill({ body: html, contentType: 'text/html' });
    });
    await page.goto(`https://app.shopmonkey.cloud/orders/${order}?locationId=${shop}`);
    await page.evaluate(() => {
      window.prints = 0;
      window.chrome = { runtime: {
        id: 'offline', getURL: p => p, onMessage: { addListener() {} },
        sendMessage(message, done) {
          if (message.action === 'GET_SHOP_FEATURES') done({ success: true, floatingButtonEnabled: true, features: { oil_sticker: true } });
          else if (message.action === 'PRINT_STICKER_IMMEDIATE') window.immediatePrint(message.context).then(done);
          return Promise.resolve();
        },
      } };
      window.MosStickerButtonPreference = { start() {}, route: () => false };
    });
    for (const file of ['sticker-print-core.js', 'adapters/shopmonkey-buttons.js', 'adapters/shopmonkey-content.js']) {
      await page.addScriptTag({ content: fs.readFileSync(`mos-tools-extension/${file}`, 'utf8') });
    }
    // Keep real image decoding and final-context checks; only replace the OS dialog.
    await page.evaluate(() => {
      const original = MosStickerPrintCore;
      window.MosStickerPrintCore = { ...original, whenReady(img, print, fail) {
        img.ownerDocument.defaultView.print = () => { window.prints++; };
        original.whenReady(img, print, fail);
      } };
    });
    await page.locator('#mos-shopmonkey-actions button').nth(1).click();
    await page.waitForFunction(() => window.prints === 1);
    assert.ok(calls.some(path => path.includes('provider=shopmonkey')));
    assert.ok(calls.includes('/api/extension/sticker'));
    navigateDuringGeneration = true;
    await page.locator('#mos-shopmonkey-actions button').nth(1).click();
    await page.waitForFunction(() => location.pathname.endsWith('/new-order'));
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.prints), 1);
  } finally { await browser.close(); }
});
