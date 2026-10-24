const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function adapter(text) {
  const sandbox = {
    console: { log() {} },
    URL,
    window: { location: { href: 'https://app.shopmonkey.cloud/order/404daad9-c97c-41b2-9ac9-85d6074de488' } },
    document: { body: { innerText: text }, title: '', readyState: 'loading',
      querySelectorAll: () => [], addEventListener() {} },
    localStorage: { length: 0 },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('mos-tools-extension/adapters/shopmonkey-content.js', 'utf8'), sandbox);
  return { raw: () => vm.runInContext('_detectContextRaw()', sandbox),
    run: code => vm.runInContext(code, sandbox) };
}

test('estimate screenshot layout: order, vehicle, VIN and header mileage', () => {
  const ctx = adapter('2011 Ford F-350 Super Duty Lariat\nPlate: DEMO VIN: 1FT8W3BT0BEA08647\n119,067 / —\nEstimate #1000\nAssignments\n1 of 1\nNext Maintenance\n120,000 mi').raw();
  assert.equal(ctx.provider, 'shopmonkey');
  assert.equal(ctx.roId, '404daad9-c97c-41b2-9ac9-85d6074de488');
  assert.equal(ctx.roNumber, '1000');
  assert.equal(ctx.vin, '1FT8W3BT0BEA08647');
  assert.equal(ctx.vehicleDisplay, '2011 Ford F-350 Super Duty Lariat');
  assert.equal(ctx.mileage, 119067);
});

test('VIN and maintenance suggestion never become current mileage', () => {
  assert.equal(adapter('VIN: 1FT8W3BT0BEA08647\nAssignments\n1 of 1\nNext Maintenance\n120,000 mi').raw().mileage, null);
});

test('explicit mileage labels still work without reading VIN prefix', () => {
  assert.equal(adapter('VIN: 1FT8W3BT0BEA08647\nMileage: 119,067').raw().mileage, 119067);
});

test('cached context cannot cross shop boundaries', () => {
  const a = adapter('');
  a.run("rememberOrderContext({shopId:'shop-a',roId:'order-1',mileage:119067})");
  assert.equal(a.run("hydrateContextFromCache({shopId:'shop-b',roId:'order-1'}).mileage"), undefined);
  assert.equal(a.run("hydrateContextFromCache({shopId:'shop-a',roId:'order-1'}).mileage"), 119067);
});
