const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('keytag-only Shopmonkey panel allows scoped manual entry without Maintenance enrichment', async () => {
  const source = fs.readFileSync('mos-tools-extension/sidepanel.js', 'utf8');
  const element = () => ({ value: '', style: {}, classList: { add() {}, remove() {} } });
  const elements = Object.fromEntries(['keytagCustomer', 'keytagVehicle', 'keytagRo', 'keytagMileage', 'keytagPrintBtn', 'keytagError', 'keytagSection', 'stickerLoading'].map(k => [k, element()]));
  const requests = [];
  let output;
  const ctx = { provider: 'shopmonkey', shopId: 'location-a', roId: 'order-a', _tabId: 1 };
  const sandbox = {
    console, URLSearchParams, elements, currentContext: ctx,
    shopFeatures: { keytags: true, maintenance: false },
    keytagEnabled: false, keytagManualContextKey: null, keytagExtrasKey: null,
    keytagStatus: 'idle', keytagLastEnrichedKey: null, keytagInFlightKey: null,
    keytagExtrasFields: [], keytagExtrasValues: {},
    keytagExtraContextKey: c => JSON.stringify([c?._tabId, c?.provider, c?.shopId, c?.roId]),
    loadKeytagExtras: async () => { sandbox.keytagExtrasKey = sandbox.keytagExtraContextKey(sandbox.currentContext); },
    updateKeytagFields() {},
    prefillKeytagExtras() {},
    renderKeytagExtras() {},
    showNotification() {},
    printKeytagImage: image => { output = image; },
    sendMessage: async request => {
      requests.push(request);
      assert.equal(request.endpoint, '/api/extension/keytag', 'must not fetch Maintenance-only ro-context');
      return { success: true, image: 'fixture-image', mosPrintContext: request.context };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function makeRoKey('), source.indexOf('// Separate function to update keytag fields')), sandbox);
  vm.runInContext(source.slice(source.indexOf('async function handleKeytagPrint()'), source.indexOf('function printKeytagImage(')), sandbox);
  await sandbox.loadKeytagSection();
  assert.equal(elements.keytagPrintBtn.disabled, true);
  assert.equal(elements.keytagVehicle.readOnly, false);
  elements.keytagCustomer.value = 'Customer';
  elements.keytagVehicle.value = '2020 Test Vehicle';
  elements.keytagRo.value = '100';
  elements.keytagRo.oninput();
  assert.equal(elements.keytagPrintBtn.disabled, false);
  await sandbox.handleKeytagPrint();
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.body).provider, 'shopmonkey');
  assert.equal(output.mosPrintContext.shopId, 'location-a');
  sandbox.currentContext = { ...ctx, shopId: 'location-b', roId: 'order-b' };
  sandbox.recomputeKeytagPrintLock();
  assert.equal(elements.keytagPrintBtn.disabled, true);
  await sandbox.handleKeytagPrint();
  assert.equal(requests.length, 1, 'old manual fields cannot print in new location');
  await sandbox.loadKeytagSection();
  assert.equal(elements.keytagCustomer.value, '');
  assert.equal(elements.keytagPrintBtn.disabled, true);
  assert.equal(requests.length, 1);
});
