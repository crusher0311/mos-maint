const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { createFixture } = require('./browser/maintenance-color-fixture.cjs');

(async () => {
  const server = await createFixture();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || execFileSync('which', ['chromium']).toString().trim(),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => r.url().startsWith(origin) ? r.continue() : r.abort());
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const load = async shop => { await page.goto(`${origin}/?shop=${shop}`); await page.waitForFunction(() => document.body.textContent.includes('Regional Settings')); };
    const value = () => page.$eval('#maintenance-color', el => el.value);
    const save = async () => {
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Save Preferences')));
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Save Preferences')).click());
      await page.waitForFunction(() => document.body.textContent.includes('Saved'));
    };
    await load(1);
    assert.equal(await value(), 'red');
    await save();
    assert.equal(await page.evaluate(() => 'tekmetricMaintenanceColor' in fixtureWrites[0]), false, 'unrelated saves omit color');
    await page.select('#maintenance-color', 'yellow');
    await save();
    await load(1);
    assert.equal(await value(), 'yellow');
    await save();
    assert.equal(await page.evaluate(() => 'tekmetricMaintenanceColor' in fixtureWrites[0]), false);
    await load(2);
    assert.equal(await value(), 'red', 'separate shop default');
    await load(1);
    assert.equal(await value(), 'yellow');
    await page.select('#maintenance-color', 'red');
    await save();
    await load(1);
    assert.equal(await value(), 'red');
    await load(3);
    assert.equal(await page.$('#maintenance-color'), null, 'hidden for other providers');
    await page.goto(origin + '/?shop=1&role=viewer');
    await page.waitForSelector('#maintenance-color');
    assert.equal(await page.$eval('#maintenance-color', el => el.disabled), true);
    await save();
    assert.equal(await page.evaluate(() => 'tekmetricMaintenanceColor' in fixtureWrites[0]), false, 'read-only UI never submits this preference');
    assert.deepEqual(errors, []);
    console.log('PASS real Preferences page: red default, explicit yellow/red save/reload, omitted-field saves, shop isolation and provider visibility');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
