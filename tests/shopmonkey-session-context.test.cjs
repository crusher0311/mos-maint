const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const company = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const a = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const b = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
function fixture() {
  let time = 1000000;
  const messages = [], listeners = {};
  const location = { origin: 'https://app.shopmonkey.cloud', pathname: '/order/one' };
  const window = { postMessage: m => messages.push(m),
    addEventListener: (k, fn) => { listeners[k] = fn; } };
  const sandbox = { window, location, URL, Headers, atob,
    Date: { now: () => time } };
  vm.runInNewContext(fs.readFileSync('mos-tools-extension/adapters/shopmonkey-session-context.js', 'utf8'), sandbox);
  const token = (lid, extra = {}) => 'head.' + Buffer.from(JSON.stringify({
    cid: company, lid, iss: 'https://api.shopmonkey.cloud', aud: 'shop',
    exp: 2000, ...extra })).toString('base64url') + '.signature';
  return { messages, location, token, window,
    advance: ms => { time += ms; },
    observe: (lid, extra, url = '/api/v3/order') =>
      window.MosShopmonkeySessionContext.observe(url, { Authorization: 'Bearer ' + token(lid, extra) }),
    request: (source = window, origin = location.origin) =>
      listeners.message({ source, origin, data: { type: 'MOS_REQUEST_SHOPMONKEY_CONTEXT' } }),
  };
}
test('early same-tab context replays without credentials and updates on switching', () => {
  const f = fixture();
  f.observe(a);
  f.request();
  assert.equal(f.messages.at(-1).context.locationId, a);
  assert.equal(Object.keys(f.messages.at(-1).context).sort().join(','), 'companyId,expiresAt,locationId,path');
  assert.ok(!JSON.stringify(f.messages).includes(f.token(a)));
  f.observe(b);
  assert.equal(f.messages.at(-1).context.locationId, b);
  f.location.pathname = '/order/two';
  f.request();
  assert.equal(f.messages.at(-1).context, null);
  f.observe(a);
  assert.equal(f.messages.at(-1).context.path, '/order/two');
});
test('separate tabs, expired or invalid claims, wrong hosts and foreign messages fail closed', () => {
  const f = fixture(), second = fixture();
  f.observe(a); second.observe(b);
  f.request(); assert.equal(f.messages.at(-1).context.locationId, a);
  f.advance(60001); f.request(); assert.equal(f.messages.at(-1).context, null);
  for (const extra of [{ exp: 0 }, { iss: 'https://other.test' }, { aud: 'other' }, { cid: 'bad' }]) {
    f.observe(a, extra); assert.equal(f.messages.at(-1).context, null);
  }
  const count = f.messages.length;
  f.observe(a, {}, 'https://other.test/api/v3/order');
  f.request({}); f.request(f.window, 'https://other.test');
  assert.equal(f.messages.length, count);
});
test('content adapter prefers fresh session context over stale storage and clears on navigation', () => {
  const handlers = {};
  const location = { origin: 'https://app.shopmonkey.cloud', pathname: '/order/one',
    href: 'https://app.shopmonkey.cloud/order/one' };
  const window = { location, addEventListener: (k, fn) => { handlers[k] = fn; } };
  const sandbox = { window, URL, console: { log() {} }, Date,
    localStorage: { length: 1, key: () => 'locationId', getItem: () => b },
    document: { body: { innerText: '' }, title: '', readyState: 'loading',
      querySelectorAll: () => [], addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('mos-tools-extension/adapters/shopmonkey-content.js', 'utf8'), sandbox);
  handlers.message({ source: window, origin: location.origin, data: {
    type: 'MOS_SHOPMONKEY_SESSION_CONTEXT',
    context: { companyId: company, locationId: a, path: location.pathname, expiresAt: Date.now() + 60000 },
  } });
  assert.equal(vm.runInContext('detectShopIdentifiers().locationId', sandbox), a);
  location.pathname = '/order/two';
  assert.equal(vm.runInContext('detectShopIdentifiers().locationId', sandbox), null);
  location.pathname = '/order/one';
  handlers.message({ source: window, origin: location.origin, data: {
    type: 'MOS_SHOPMONKEY_SESSION_CONTEXT', observed: true, context: null,
  } });
  assert.equal(vm.runInContext('detectShopIdentifiers().locationId', sandbox), null);
});
test('interceptor fetch and XHR diagnostics never log request credentials or bodies', async () => {
  const logs = [], observed = [];
  class XHR {
    open() {} setRequestHeader() {} send() {} addEventListener() {}
  }
  const window = { location: { origin: 'https://app.shopmonkey.cloud' },
    addEventListener() {}, postMessage() {}, fetch: async () => ({ status: 200 }),
    MosShopmonkeySessionContext: { observe: (...args) => observed.push(args) } };
  vm.runInNewContext(fs.readFileSync('mos-tools-extension/adapters/interceptor.js', 'utf8'), {
    window, XMLHttpRequest: XHR, Headers, URL, console: { log: (...args) => logs.push(args) },
  });
  await window.fetch('/api/v3/order?secret=PRIVATE', {
    method: 'POST', headers: { Authorization: 'Bearer PRIVATE' }, body: '{"customer":"PRIVATE"}',
  });
  const xhr = new XHR();
  xhr.open('POST', '/api/v3/order?secret=PRIVATE');
  xhr.setRequestHeader('Authorization', 'Bearer PRIVATE');
  xhr.send('PRIVATE');
  assert.equal(observed.length, 2);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
});
