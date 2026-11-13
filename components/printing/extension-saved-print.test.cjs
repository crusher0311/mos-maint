const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../mos-tools-extension/background.js'), 'utf8');
const enqueueSource = source.slice(source.indexOf('async function enqueueSavedIpp('), source.indexOf('function renderedStickerStock('));
const context = { provider: 'tekmetric', shopId: 'sms-43', roId: 'ro-12', _tabId: 7 };
const destination = { id: 'parts-counter', kind: 'keytag', supported: true, online: true, revision: 'rev-2', stock: { width: 8890, height: 2858 } };
const payload = () => ({ transport: 'ipp', type: 'keytag', destinationId: destination.id, revision: destination.revision,
  stock: destination.stock, printActionId: '0c7420fe-0101-4101-8101-010101010101', imageBase64: 'data:image/png;base64,aGVsbG8=' });
function harness({ tier = { canMutate: true, canAdmin: true }, ambiguous = false, destinationOverride = {} } = {}) {
  const calls = [];
  const sandbox = {
    assertSavedPrintContext() {},
    savedIppActions: new Map(),
    mosSessionTier: tier,
    savedPrintParams: () => 'kind=keytag&smsShopId=sms-43&provider=tekmetric',
    savedPrintStatusLabels: { queued: 'Queued', unknown: 'Outcome unknown — check printer' },
    async handleMosApiRequest(endpoint, options) {
      calls.push({ endpoint, options });
      if (endpoint.includes('destinations')) return { shopId: 28, kind: 'keytag', destinations: [{ ...destination, ...destinationOverride }] };
      if (ambiguous) throw new Error('Connection lost after request');
      return { success: true, jobId: 'job-23' };
    },
  };
  vm.createContext(sandbox); vm.runInContext(enqueueSource, sandbox);
  return { send: (body, calibration = false) => sandbox.enqueueSavedIpp(body, context, calibration), calls };
}
test('duplicate clicks issue exactly one enqueue and preserve PNG unchanged', async () => {
  const worker = harness();
  const job = payload();
  const [first, second] = await Promise.all([worker.send(job), worker.send(job)]);
  assert.equal(first.jobId, 'job-23'); assert.equal(second.jobId, first.jobId);
  const posts = worker.calls.filter(call => call.endpoint === '/api/extension/print');
  assert.equal(posts.length, 1);
  const wire = JSON.parse(posts[0].options.body);
  assert.equal(wire.imageBase64, job.imageBase64);
  assert.equal(wire.smsShopId, context.shopId);
  assert.equal(wire.provider, context.provider);
  assert.equal(wire.printActionId, job.printActionId);
});
test('ambiguous response stays pinned and never automatically resubmits', async () => {
  const worker = harness({ ambiguous: true });
  const first = await worker.send(payload());
  const second = await worker.send(payload());
  assert.equal(first.status, 'unknown');
  assert.equal(first.printActionId, payload().printActionId);
  assert.equal(second.status, 'unknown');
  assert.equal(worker.calls.filter(call => call.endpoint === '/api/extension/print').length, 1);
});
test('Basic cannot upload arbitrary images, even claimed keytag PNG', async () => {
  const worker = harness({ tier: { canMutate: false, canAdmin: false } });
  await assert.rejects(() => worker.send(payload()), /Basic supports only shop-rendered keytags/);
  assert.equal(worker.calls.length, 0);
});
test('Basic constrained keytag uses existing keytag fields and no image bytes', async () => {
  const worker = harness({ tier: { canMutate: false, canAdmin: false } });
  const job = payload(); delete job.imageBase64;
  job.keytag = { customerName: 'Maya Torres', vehicleInfo: '2018 Honda Accord', roNumber: '6832', extraValues: {} };
  assert.equal((await worker.send(job)).success, true);
  const wire = JSON.parse(worker.calls.at(-1).options.body);
  assert.equal(wire.imageBase64, undefined);
  assert.equal(wire.keytag.roNumber, '6832');
});
test('mismatched rendered physical stock never enqueues', async () => {
  const worker = harness();
  const job = payload(); job.stock = { width: 5080, height: 6350 };
  const result = await worker.send(job);
  assert.equal(result.success, false);
  assert.match(result.error, /Rendered label dimensions/);
  assert.equal(worker.calls.length, 1);
});
test('calibration posts to dedicated server-rendered endpoint without customer image', async () => {
  const worker = harness();
  const job = payload(); delete job.imageBase64;
  assert.equal((await worker.send(job, true)).success, true);
  assert.equal(worker.calls.at(-1).endpoint, '/api/extension/print/test');
  const wire = JSON.parse(worker.calls.at(-1).options.body);
  assert.equal(wire.kind, 'keytag');
  assert.equal(wire.imageBase64, undefined);
  assert.equal(wire.keytag, undefined);
});
test('Basic cannot use calibration endpoint', async () => {
  const worker = harness({ tier: { canMutate: false, canAdmin: false } });
  await assert.rejects(() => worker.send(payload(), true), /Manager verification/);
});
test('offline, unsupported, or revised destinations never enqueue or fall back', async () => {
  for (const destinationOverride of [{ online: false }, { supported: false }, { revision: 'rev-3' }]) {
    const worker = harness({ destinationOverride });
    const result = await worker.send(payload());
    assert.equal(result.success, false);
    assert.match(result.error, /unavailable or changed/);
    assert.equal(worker.calls.length, 1);
  }
});
test('saved printing rejects stale RO, provider, tab, and provider-session scope', () => {
  const scopeSource = source.slice(source.indexOf('function assertSavedPrintContext('), source.indexOf('function savedPrintParams('));
  const sandbox = { activeTabId: 7, smsContextsByTab: new Map([[7, context]]), laborRateSessionDiscriminatorForTab: () => 'session-2' };
  vm.createContext(sandbox); vm.runInContext(scopeSource, sandbox);
  assert.doesNotThrow(() => sandbox.assertSavedPrintContext({ ...context, laborRateSessionDiscriminator: 'session-2' }));
  for (const patch of [{ roId: 'ro-other' }, { provider: 'shopmonkey' }, { shopId: 'other-shop' }, { _tabId: 8 }, { laborRateSessionDiscriminator: 'session-1' }]) {
    assert.throws(() => sandbox.assertSavedPrintContext({ ...context, ...patch }), /originating shop or work order changed/);
  }
});
