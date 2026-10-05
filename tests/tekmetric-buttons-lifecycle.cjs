// Real Chromium DOM tests, synthetic data only; no extension/API writes.
// Run: node tests/tekmetric-buttons-lifecycle.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const adapter = fs.readFileSync('mos-tools-extension/adapters/tekmetric-content.js', 'utf8');
const fixture = fs.readFileSync('tests/fixtures/synthetic/tekmetric-ro.html', 'utf8');
const ids = ['mos-print-button', 'mos-prefill-dvi-btn', 'mos-enhance-notes-btn', 'mos-build-ro-vhi-btn', 'mos-fab'];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || execFileSync('which', ['chromium']).toString().trim(),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => r.isNavigationRequest()
      ? r.respond({ status: 200, contentType: 'text/html', body: fixture })
      : r.abort());
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('https://shop.tekmetric.com/shop/1/repair-orders/101');
    await page.evaluate(() => {
      let now = 100000, next = 1;
      const timers = new Map();
      Date.now = () => now;
      window.setTimeout = (fn, ms = 0) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id; };
      window.setInterval = (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms, ms }); return id; };
      window.clearTimeout = window.clearInterval = id => timers.delete(id);
      window.tick = ms => {
        const end = now + ms;
        let count = 0;
        while (true) {
          const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!entry) break;
          if (++count > 10000) throw new Error('unbounded timers');
          const [id, t] = entry;
          now = t.at;
          if (t.ms) t.at += t.ms; else timers.delete(id);
          t.fn();
        }
        now = end;
      };
      window.messages = [];
      window.pendingFeatures = [];
      window.mode = 'fail';
      window.answer = { success: true, features: { dvi_prefill: true, enhance_notes: true }, floatingButtonEnabled: true };
      window.storageListeners = [];
      window.chrome = {
        runtime: {
          id: 'synthetic', getURL: s => 'https://assets.invalid/' + s,
          onMessage: { addListener() {} },
          sendMessage(m, cb) {
            messages.push(m);
            if (m.action === 'GET_SHOP_FEATURES') {
              if (mode === 'hang') { pendingFeatures.push(cb); return; }
              if (mode === 'throw') throw new Error('Extension context invalidated');
              if (mode === 'reject') return Promise.reject(new Error('transport'));
              cb?.(mode === 'fail' ? { success: false } : structuredClone(answer));
            } else if (m.action === 'GET_STICKER_CONFIG') cb?.({ success: true, intervals: [] });
            else cb?.({ success: true, snapshots: [] });
          },
        },
        storage: { onChanged: { addListener(fn) { storageListeners.push(fn); } } },
      };
      window.identityChange = () => storageListeners.forEach(fn => fn({ mosUser: {} }, 'local'));
    });
    await page.addScriptTag({ content: adapter });
    const run = code => page.evaluate(code);
    const counts = () => page.evaluate(ids => ids.map(id => document.querySelectorAll('#' + id).length), ids);
    const all = async label => { assert.deepEqual(await counts(), [1, 1, 1, 1, 1], label); console.log('PASS', label); };
    assert.equal(await run(`document.querySelectorAll('#mos-fab').length`), 0, 'initial failed/no-token settings cannot reveal a disabled launcher');
    await run(`mode='hang'; identityChange(); tick(12000)`);
    assert.equal(await run(`document.querySelectorAll('#mos-fab').length`), 0, 'hung initial settings do not assume On');
    await run(`history.pushState({}, '', '/shop/2'); mode='fail'; tick(2000)`);
    assert.equal(await run(`document.querySelectorAll('#mos-fab').length`), 0, 'non-RO shop initial failure does not assume On');
    await run(`history.pushState({}, '', '/shop/3'); mode='hang'; tick(14000)`);
    assert.equal(await run(`document.querySelectorAll('#mos-fab').length`), 0, 'non-RO shop hung settings do not assume On');
    await run(`history.pushState({}, '', '/shop/1/repair-orders/101'); mode='ok'; tick(2000)`);
    await run('tick(2000)');
    await all('initial eligible controls');
    await run(`answer.floatingButtonEnabled=false; tick(62000)`);
    assert.equal(await run(`document.querySelectorAll('#mos-fab').length`), 0, 'remote Off setting applied on refresh');
    await run(`history.pushState({}, '', '/shop/1/repair-orders/102'); tick(2000)`);
    assert.equal(await run(`document.querySelectorAll('#mos-fab').length`), 0, 'Off survives RO navigation');
    await run(`mode='hang'; identityChange(); tick(12000)`);
    assert.equal(await run(`document.querySelectorAll('#mos-fab').length`), 0, 'identity reset cannot flash a previously hidden launcher');
    await run(`mode='ok'; answer.floatingButtonEnabled=true; tick(32000)`);
    await all('confirmed On restores launcher');
    await run(`window.toolbar = document.querySelector('.action-bar').outerHTML;
      document.querySelector('.action-bar').outerHTML = toolbar.replace(/<button[^>]*id="mos-[\\s\\S]*?<\\/button>/g, '');
      document.getElementById('mos-fab').remove(); tick(2000)`);
    await all('same-URL toolbar and floating control replacement');
    await run(`document.querySelector('.action-bar').remove(); tick(6000)`);
    assert.deepEqual(await counts(), [0, 0, 0, 0, 1]);
    await run(`document.querySelector('.ro-header').insertAdjacentHTML('beforeend', toolbar);
      document.querySelectorAll('[id^="mos-"]').forEach(n => { if(n.id !== 'mos-fab') n.remove(); }); tick(2000)`);
    await all('late toolbar insertion');
    await run(`document.querySelector('.action-bar').style.display='none';
      const fresh = document.createElement('div'); fresh.className='action-bar';
      fresh.innerHTML='<button title="Print">Print</button>'; document.querySelector('.ro-header').append(fresh); tick(2000)`);
    await all('hidden old toolbar does not retain controls');
    assert.equal(await run(`document.getElementById('mos-print-button').parentElement.style.display`), '');
    await run(`history.pushState({}, '', '/shop/1/repair-orders/202'); tick(2000);
      document.getElementById('mos-print-button').click()`);
    assert.equal(await run(`messages.filter(m => m.action === 'PRINT_STICKER_IMMEDIATE').at(-1).context.roId`), '202');
    await all('direct RO transition');
    await run(`tick(10000); document.getElementById('mos-print-button').click()`);
    assert.equal(await run(`messages.filter(m => m.action === 'PRINT_STICKER_IMMEDIATE').length`), 2, 'single click handler');
    await run(`document.getElementById('mos-print-button').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }))`);
    assert.equal(await run(`document.querySelectorAll('#mos-interval-dropdown').length`), 1);
    console.log('PASS print click and right-click interval dropdown');
    await run(`answer.buttonVisibility = { tekmetric: { oil_sticker:false, dvi_prefill:false, enhance_notes:false, add_vhi_recommendations:false } };
      answer.floatingButtonEnabled = false; identityChange(); tick(2000)`);
    assert.deepEqual(await counts(), [0, 0, 0, 0, 0], 'user hidden');
    await run(`mode='fail'; tick(65000)`);
    assert.deepEqual(await counts(), [0, 0, 0, 0, 0], 'hidden preferences survive transient failures');
    await run(`mode='ok'; answer = {success:true, features:{dvi_prefill:false, enhance_notes:false}, floatingButtonEnabled:false};
      identityChange(); tick(2000)`);
    assert.deepEqual(await counts(), [1, 0, 0, 0, 0], 'denied features remain denied, print ungated');
    await run(`mode='hang'; identityChange(); tick(12000)`);
    assert.equal(await run('featuresFetchInFlight'), false, 'hung message released');
    assert.equal(await run('cachedFeatures'), null, 'failure not cached as denial');
    assert.equal(await run(`document.querySelectorAll('#mos-print-button').length`), 1, 'print after timeout');
    await run(`answer={success:true,features:{dvi_prefill:true,enhance_notes:true},floatingButtonEnabled:true}; mode='ok'; tick(32000)`);
    await all('automatic recovery after hung settings');
    await run(`mode='hang'; identityChange(); window.oldReply=pendingFeatures.at(-1);
      history.pushState({}, '', '/shop/2/repair-orders/303'); tick(2000);
      oldReply({success:true,features:{dvi_prefill:true,enhance_notes:true}});`);
    // The old identity/shop response must not become this shop's cache.
    assert.equal(await run('featuresScope'), '2');
    assert.equal(await run('cachedFeatures'), null, 'late old-shop response rejected');
    await run(`mode='ok'; answer={success:true,features:{},floatingButtonEnabled:false}; identityChange(); tick(2000)`);
    assert.deepEqual(await counts(), [1, 0, 0, 0, 0]);
    await run(`mode='throw'; identityChange(); tick(2000)`);
    assert.equal(await run('featuresFetchInFlight'), false);
    await run(`mode='ok'; answer={success:true,features:{dvi_prefill:true,enhance_notes:true},floatingButtonEnabled:true};
      identityChange(); tick(2000); document.getElementById('mos-fab').remove(); tick(2000);
      document.getElementById('mos-fab').dispatchEvent(new MouseEvent('mousedown', {clientY:100}));
      document.dispatchEvent(new MouseEvent('mouseup', {clientY:100})); tick(500)`);
    assert.equal(await run(`messages.filter(m => m.action === 'OPEN_SIDE_PANEL').length`), 1, 'recreated FAB has one document drag handler');
    await run(`mode='reject'; identityChange()`);
    await run('tick(2000)');
    assert.equal(await run('featuresFetchInFlight'), false);
    await run(`chrome.runtime.id = null; tick(10000)`);
    assert.ok(await run(`lifecycleDiagnosticTimes.has('context_invalidated')`));
    assert.ok(await run(`lifecycleDiagnosticTimes.has('anchor_missing') && lifecycleDiagnosticTimes.has('control_detached') && lifecycleDiagnosticTimes.has('settings_timeout')`));
    assert.deepEqual(errors, [], 'no browser script errors');
    console.log('PASS hidden, denied, deadlines, transport errors, identity/shop isolation and bounded diagnostics');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });