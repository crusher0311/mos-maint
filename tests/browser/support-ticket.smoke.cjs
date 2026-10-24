// Run: node tests/browser/support-ticket.smoke.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { start } = require('./support-ticket-fixture.cjs');

(async () => {
  const server = start();
  await new Promise(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: execFileSync('which', ['chromium'], {encoding:'utf8'}).trim(),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on('request', req => req.url().startsWith(origin + '/') ? req.continue() : req.abort());
    for (const width of [240, 280, 320, 400]) {
      await page.setViewport({width, height:700});
      await page.goto(origin);
      const geometry = await page.evaluate(() => {
        const selectors = ['.support-panel-title', '#support-ticket-btn', '#support-close-btn'];
        return {
          boxes: selectors.map(s => {
            const r = document.querySelector(s).getBoundingClientRect();
            return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};
          }),
          overflow: document.documentElement.scrollWidth > innerWidth,
          label: document.querySelector('#support-ticket-btn').innerText,
          name: document.querySelector('#support-ticket-btn').getAttribute('aria-label'),
          title: document.querySelector('#support-ticket-btn').title,
        };
      });
      assert.equal(geometry.label, 'Create a ticket');
      assert.equal(geometry.name, geometry.label);
      assert.equal(geometry.title, geometry.label);
      assert.equal(geometry.overflow, false);
      geometry.boxes.forEach(b => assert(b.left >= 0 && b.right <= width));
      for (let i = 0; i < geometry.boxes.length; i++) {
        for (const b of geometry.boxes.slice(i + 1)) {
          const a = geometry.boxes[i];
          assert(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        }
      }
      assert.equal(geometry.boxes[2].width, 32);
      assert.equal(geometry.boxes[2].height, 32);
      for (const action of ['span', 'svg', 'Enter', 'Space']) {
        if (action === 'span' || action === 'svg') await page.click(`#support-ticket-btn ${action}`);
        else {
          await page.focus('#support-ticket-btn');
          await page.keyboard.press(action);
          assert.equal(await page.$eval('#support-ticket-btn', e => getComputedStyle(e).outlineStyle), 'solid');
        }
        assert.equal(await page.$eval('#support-ticket-view', e => !e.classList.contains('hidden')), true);
        assert.equal(await page.$eval('#support-chat-view', e => e.classList.contains('hidden')), true);
        await page.click('#support-ticket-back-btn');
      }
      await page.focus('#support-ticket-btn');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'support-close-btn');
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval('#support-chat-panel', e => e.classList.contains('hidden')), true);
      assert.deepEqual(await page.evaluate(() => serviceCalls), []);
    }
    assert.deepEqual(errors, []);
    console.log('Support ticket: label, icon, keyboard, close and layouts passed at 240/280/320/400px; no service calls.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
