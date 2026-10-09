// Isolated source-level UI regression. No app, database, or network is started.
// Run: node components/vehicle-history-ui.regression.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'mos-tools-extension/sidepanel.js'), 'utf8');
const historySource = source.slice(source.indexOf('// Vehicle evidence is deliberately'), source.indexOf('// Estimate-audit requests'));
const body = { innerHTML: '', replaceChildren() { this.innerHTML = ''; } };
let historyHidden = true;
let mainHidden = false;
const section = { classList: { add() { historyHidden = true; }, remove() { historyHidden = false; } } };
const main = { classList: { contains() { return mainHidden; } } };
const listeners = {};
const requests = [];
const timers = [];
const context = vm.createContext({
  URLSearchParams,
  isAuthenticated: true,
  currentTab: 'plan',
  currentContext: { provider: 'tekmetric', shopId: 248, roId: '72', vin: 'VIN_A' },
  document: {
    visibilityState: 'visible',
    getElementById(id) { return id === 'vehicle-history-body' ? body : id === 'main-state' ? main : section; },
    addEventListener(name, fn) { listeners[`document:${name}`] = fn; },
  },
  window: { addEventListener(name, fn) { listeners[`window:${name}`] = fn; } },
  setInterval(fn, delay) { timers.push({ fn, delay }); return timers.length; },
  clearInterval() {},
  escEstimate(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); },
  sendMessage(message) { return new Promise(resolve => requests.push({ message, resolve })); },
});
vm.runInContext(historySource, context);
const execute = code => vm.runInContext(code, context);
const payload = vin => ({
  enabled: true, vin, currentShopId: 19, policyRevision: 'rev-3', checkedAt: '2026-04-17T12:00:00Z',
  locations: [{ shopId: 19, name: 'West service', state: 'incomplete', hasMore: true, fetchedAt: null }],
  events: [{
    id: 'evt-1', shopId: 19, location: 'West service', provider: 'tekmetric', workOrderId: '72',
    jobId: 'job-9', title: '<script>Brake pads</script>', date: null, mileage: 0, mileageUnit: 'miles',
    status: 'declined', origin: 'normalized job', readOnly: true,
    resolution: { state: 'partial', completedBy: ['East service'], remainingComponents: ['Rear pads'] },
  }],
});

async function test() {
  const initial = execute('fetchVehicleHistory()');
  assert.match(body.innerHTML, /Checking evidence/);
  assert.equal(requests[0].message.options.cache, 'no-store');
  assert.equal(requests[0].message.context.shopId, 248);
  assert.match(requests[0].message.endpoint, /vin=VIN_A&shopId=248&provider=tekmetric/);
  requests[0].resolve(payload('VIN_A'));
  await initial;
  assert.match(body.innerHTML, /Partial location coverage/);
  assert.match(body.innerHTML, /More records not shown/);
  assert.match(body.innerHTML, /Deferred \/ declined/);
  assert.match(body.innerHTML, /Partially completed elsewhere/);
  assert.match(body.innerHTML, /0 mi/);
  assert.match(body.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(body.innerHTML, /<script>|btn-add|data-job-id/);

  const failed = execute('fetchVehicleHistory()');
  assert.doesNotMatch(body.innerHTML, /Brake pads/);
  requests[1].resolve({ error: 'offline' });
  await failed;
  assert.match(body.innerHTML, /Vehicle history unavailable/);
  assert.doesNotMatch(body.innerHTML, /Brake pads/);

  const older = execute('fetchVehicleHistory()');
  execute("currentContext = { provider: 'shopware', shopId: 851, roId: '72', vin: 'VIN_B' }; clearVehicleHistory()");
  const newer = execute('fetchVehicleHistory()');
  requests[3].resolve({ ...payload('VIN_B'), enabled: false, events: [], reason: 'Policy off' });
  await newer;
  requests[2].resolve(payload('VIN_A'));
  await older;
  assert.match(body.innerHTML, /sharing is off/);
  assert.doesNotMatch(body.innerHTML, /Brake pads/);

  const mismatch = execute('fetchVehicleHistory()');
  requests[4].resolve(payload('VIN_A'));
  await mismatch;
  assert.match(body.innerHTML, /Vehicle history unavailable/);
  execute('syncVehicleHistoryRefresh()');
  assert.equal(timers.at(-1).delay, 30000);
  execute("document.visibilityState = 'hidden'");
  listeners['document:visibilitychange']();
  assert.equal(body.innerHTML, '');
  assert.equal(historyHidden, true);
  const count = requests.length;
  timers.at(-1).fn();
  assert.equal(requests.length, count);

  // Hidden application state also suppresses focus refresh, even if an old
  // isAuthenticated flag and active VIN remain in memory.
  execute("document.visibilityState = 'visible'");
  mainHidden = true;
  listeners['window:focus']();
  assert.equal(requests.length, count);
  assert.equal(body.innerHTML, '');
  assert.equal(historyHidden, true);
  mainHidden = false;

  // Evaluate the actual entry-point declarations, not duplicate test hooks.
  // Trap immediately after their evidence-clear boundary so no unrelated app
  // bootstrap runs in this isolated VM.
  const ast = ts.createSourceFile('sidepanel.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(node => [node.name?.text, node.getText(ast)]));
  context.elements = {
    loadingState: { classList: { remove() {}, add() {} } },
    loginState: { classList: { remove() {}, add() {} } },
    mainState: { classList: { remove() { mainHidden = false; }, add() { mainHidden = true; } } },
  };
  const stop = () => { throw new Error('AFTER_CLEAR_BOUNDARY'); };
  Object.assign(context, {
    setPasswordVisibility: stop,
    updateLaborRateSession: stop,
    invalidateEstimateAudit: stop,
    estimateAuditContextKey: stop,
    laborRateSessionDiscriminator: null,
    enrichContextWithMosShop: value => value,
  });
  for (const name of ['showLoadingState', 'showLoginState', 'applyAuthenticatedState', 'switchTab', 'updateContext']) {
    vm.runInContext(declarations.get(name), context);
  }
  for (const call of [
    'showLoadingState()',
    'showLoginState()',
    'applyAuthenticatedState({ shops: [] })',
    "switchTab('jobs')",
    "updateContext({ provider: 'tekmetric', shopId: 921, roId: '72', vin: 'VIN_C' })",
  ]) {
    execute("currentTab = 'plan'; renderVehicleHistory(null)");
    body.innerHTML = 'PREVIOUS_VEHICLE_EVIDENCE';
    assert.equal(historyHidden, false);
    try { execute(call); } catch (error) { assert.match(error.message, /AFTER_CLEAR_BOUNDARY/); }
    assert.equal(body.innerHTML, '', `${call} must clear synchronously`);
    assert.equal(historyHidden, true, `${call} must hide synchronously`);
  }

  assert.doesNotMatch(historySource.replace(/\/\/[^\n]*/g, ''), /chrome\.storage|planCache\.get|setPlanCache\(/);
  const react = fs.readFileSync(path.join(root, 'components/enterprise-vehicle-history.tsx'), 'utf8');
  assert.match(react, /cache: "no-store"/);
  assert.match(react, /payload\.currentShopId !== currentShopId/);
  assert.match(react, /activeIdentity\.current === identity/);
  assert.match(react, /setResult\(null\)/);
  assert.match(react, /30000/);
  const settings = fs.readFileSync(path.join(root, 'components/vehicle-history-sharing-settings.tsx'), 'utf8');
  assert.match(settings, /response\.status === 409/);
  assert.match(settings, /settings\?\.canManage/);
  assert.match(settings, /JSON\.stringify\(draft\)/);
  assert.match(settings, /draft\.shopIds\.some/);
  console.log('Vehicle history UI regression passed: fresh reads, errors, scope races, coverage, read-only rendering, settings guards, and actual auth/view/context entry-point clearing including hidden state.');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
