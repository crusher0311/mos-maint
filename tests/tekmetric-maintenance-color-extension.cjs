// Real adapter DOM + real approved writer/undo functions, synthetic IO only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const background = fs.readFileSync('mos-tools-extension/background.js', 'utf8');
const adapter = fs.readFileSync('mos-tools-extension/adapters/tekmetric-content.js', 'utf8');
function sourceFunction(name) {
  const start = background.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  return background.slice(start, background.indexOf('\n}', start) + 2);
}
const originalTasks = [
  { id: 10, name: 'Engine Oil', finding: 'Original note', inspectionRating: { id: 1, code: 'CHCKD' }, media: ['retain'] },
  { id: 11, name: 'Cabin Air Filter', finding: 'Keep untouched', inspectionRating: null },
];
const writes = [], snapshots = [];
const sandbox = {
  console, setTimeout, _stateReady: Promise.resolve(), mosApiToken: 'synthetic', mosApiUrl: 'https://fixture.invalid',
  currentSmsContext: { shopId: 1 }, tekmetricShopId: 1,
  ensureBootstrapBoundToActiveTab: async () => {},
  tekmetricSessionForContext: () => ({ token: 'synthetic', origin: 'https://fixture.invalid' }),
  fetchTekmetricInspections: async () => ({ success: true, inspArr: [{ id: 9, inspectionTasks: [{ tasks: structuredClone(originalTasks) }] }] }),
  tekmetricFetch: async (url, options) => { writes.push({ url, body: JSON.parse(options.body) }); return { ok: true }; },
  saveUndoSnapshot: async snap => snapshots.push(snap),
};
vm.createContext(sandbox);
vm.runInContext(['flattenInspectionTasks', 'applyPrefillDvi', 'revertTekmetricSnapshot'].map(sourceFunction).join('\n'), sandbox);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || execFileSync('which', ['chromium']).toString().trim(),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => r.isNavigationRequest()
      ? r.respond({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' })
      : r.abort());
    await page.goto('https://shop.tekmetric.com/shop/1/repair-orders/101');
    await page.evaluate(() => {
      window.messages = [];
      window.setInterval = () => 0;
      window.chrome = {
        runtime: { id: 'fixture', getURL: s => 'https://fixture.invalid/' + s, onMessage: { addListener() {} },
          sendMessage(m, cb) { messages.push(m); cb?.({ success: false }); } },
        storage: { onChanged: { addListener() {} } },
      };
    });
    await page.addScriptTag({ content: adapter });
    const updates = ['MAYRQRATTN', 'RQRSATTN'].map((code, i) => ({
      taskId: 10 + i, taskName: originalTasks[i].name,
      rating: { id: i ? 3 : 2, code }, status: 'overdue', basis: 'vhi',
      finding: 'OVERDUE. Recommend scheduling maintenance.',
    }));
    const open = () => page.evaluate(updates => showPrefillReviewModal({
      inspectionId: 9, context: { shopId: 1, roId: 101 }, updates,
    }), updates);
    const clickText = text => page.evaluate(text => [...document.querySelectorAll('#mos-prefill-review-modal button')].find(b => b.textContent === text).click(), text);
    await open();
    const badges = await page.evaluate(() => [...document.querySelectorAll('#mos-prefill-review-modal span')]
      .filter(s => /^(Yellow|Red) ·/.test(s.textContent)).map(s => [s.textContent, s.style.color]));
    assert.deepEqual(badges, [['Yellow · Overdue', 'rgb(245, 158, 11)'], ['Red · Overdue', 'rgb(239, 68, 68)']]);
    await clickText('Cancel');
    assert.equal(await page.evaluate(() => messages.filter(m => m.action === 'PREFILL_DVI_APPLY').length), 0);
    assert.equal(writes.length, 0);
    await open();
    await page.evaluate(() => {
      document.querySelector('#mos-prefill-review-modal input[data-idx="1"]').checked = false;
      document.querySelector('#mos-prefill-review-modal textarea[data-idx="0"]').value = 'Edited maintenance note';
    });
    await clickText('Apply to DVI');
    const approval = await page.evaluate(() => messages.find(m => m.action === 'PREFILL_DVI_APPLY'));
    assert.equal(approval.approved.length, 1);
    const receipt = await sandbox.applyPrefillDvi(approval.context, approval.inspectionId, approval.approved);
    assert.equal(writes.length, 1);
    assert.match(writes[0].url, /tasks\/10$/);
    assert.equal(writes[0].body.inspectionRating.code, 'MAYRQRATTN');
    assert.equal(writes[0].body.finding, 'Edited maintenance note');
    assert.deepEqual(writes[0].body.media, ['retain']);
    assert.equal(receipt.updates[0].rating.code, 'MAYRQRATTN');
    await page.evaluate(receipt => {
      document.getElementById('mos-prefill-review-modal').remove();
      showPrefillSummaryModal(receipt);
    }, JSON.parse(JSON.stringify(receipt)));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#mos-prefill-summary-modal span')]
      .find(s => s.textContent === 'Yellow · Overdue').style.color), 'rgb(245, 158, 11)');
    await sandbox.revertTekmetricSnapshot(snapshots[0]);
    assert.deepEqual(writes[1].body, originalTasks[0], 'undo restores complete original task');
    const redReceipt = await sandbox.applyPrefillDvi({ shopId: 1, roId: 101 }, 9, [updates[1]]);
    assert.equal(writes[2].body.inspectionRating.code, 'RQRSATTN');
    assert.equal(redReceipt.updates[0].rating.code, 'RQRSATTN');
    await page.evaluate(receipt => showPrefillSummaryModal(receipt), JSON.parse(JSON.stringify(redReceipt)));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#mos-prefill-summary-modal span')]
      .find(s => s.textContent === 'Red · Overdue').style.color), 'rgb(239, 68, 68)');
    console.log('PASS review colors, cancel zero writes, selected-only PUT, receipts, red payload and exact undo');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
