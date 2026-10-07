// Execute the actual shared message-handler branch in an isolated VM.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('mos-tools-extension/background.js', 'utf8');
const start = source.indexOf('  if (message.action === "GET_SHOP_FEATURES")');
const end = source.indexOf('// ------ UNDO SNAPSHOTS', start);
assert.ok(start >= 0 && end > start, 'feature-handler extraction boundaries must exist');
const branch = `(function() { ${source.slice(start, end)} })()`;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function scenario(overrides = {}) {
  const replies = [];
  let deadline;
  const context = vm.createContext({
    message: { action: 'GET_SHOP_FEATURES', shopId: '1', provider: 'tekmetric' },
    sendResponse: r => replies.push(r),
    AbortController, Set, encodeURIComponent,
    setTimeout: fn => { deadline = fn; return 1; }, clearTimeout() {},
    _stateReady: Promise.resolve(), ensureBootstrapBoundToActiveTab: async () => {},
    authEpoch: 1, mosApiToken: 'synthetic-not-a-real-token', mosApiUrl: 'https://synthetic.invalid',
    currentSmsContext: null, console: { warn() {} },
    chrome: { storage: { local: { get: (_, cb) => cb({mosUser: {role: 'viewer'}}) } } },
    fetch: async () => ({ ok: true, json: async () => ({
      features: {dvi_prefill: true}, buttonVisibility: {tekmetric: {oil_sticker: false}},
      floatingButtonEnabled: false, integrations: ['tekmetric'], writeProvider: 'tekmetric',
    }) }),
    ...overrides,
  });
  assert.equal(vm.runInContext(branch, context), true);
  await flush();
  return { replies, context, timeout: () => deadline() };
}
(async () => {
  const good = await scenario();
  assert.equal(good.replies[0].success, true);
  assert.equal(good.replies[0].canWrite, false);
  assert.equal(good.replies[0].buttonVisibility.tekmetric.oil_sticker, false);
  assert.equal(good.replies[0].floatingButtonEnabled, false);
  assert.equal(good.replies[0].writeProvider, 'tekmetric');
  const visible = await scenario({fetch:async()=>({ok:true,json:async()=>({
    features:{},floatingButtonEnabled:true
  })})});
  assert.equal(visible.replies[0].floatingButtonEnabled,true);
  good.timeout();await flush();
  assert.equal(good.replies.length,1,'successful reply settles once');
  for (const overrides of [
    {fetch: () => new Promise(() => {})},
    {fetch: async () => ({ok:true, json: () => new Promise(() => {})})},
    {_stateReady: new Promise(() => {})},
    {ensureBootstrapBoundToActiveTab: () => new Promise(() => {})},
  ]) {
    const s = await scenario(overrides);
    s.timeout(); await flush();
    assert.equal(s.replies.length, 1);
    assert.equal(s.replies[0].code, 'FEATURES_TIMEOUT');
  }
  let resolve;
  const late = await scenario({ fetch: () => new Promise(r => resolve = r) });
  late.timeout();
  resolve({ok:true, json:async () => ({features:{}})});
  await flush();
  assert.equal(late.replies.length, 1, 'timeout cannot be overwritten');
  let resolveIdentity;
  const changed = await scenario({ fetch: () => new Promise(r => resolveIdentity = r) });
  changed.context.authEpoch++;
  resolveIdentity({ok:true, json:async () => ({features:{}})});
  await flush();
  assert.equal(changed.replies[0].success, false, 'stale identity rejected');
  for (const overrides of [
    {fetch: async () => {throw Error('network');}},
    {fetch: async () => ({ok:false})},
    {fetch: async () => ({ok:true, json:async () => ({})})},
    {mosApiToken: null},
  ]) {
    const s = await scenario(overrides);
    assert.equal(s.replies[0].success, false);
    assert.equal(s.replies[0].features, undefined, 'failure is not an authoritative denial');
    s.timeout();await flush();
    assert.equal(s.replies.length,1,'failed reply settles once');
  }
  console.log('PASS shared features: deadlines, late responses, identity, failure shapes and existing fields');
})().catch(e => { console.error(e); process.exitCode = 1; });