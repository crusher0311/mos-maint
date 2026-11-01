const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const panel = fs.readFileSync('mos-tools-extension/sidepanel.js', 'utf8');
const background = fs.readFileSync('mos-tools-extension/background.js', 'utf8');
function extract(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function fixture() {
  const requests = [], renders = [];
  const element = () => ({ classList: { add() {}, remove() {} }, querySelector: () => ({ textContent: '' }) });
  const ctx = {
    console, URLSearchParams, Date,
    isAuthenticated: true, laborRateSessionDiscriminator: 'fixture-session',
    currentContext: { provider: 'shopmonkey', shopId: 'location-a', roId: 'order-a', _tabId: 4 },
    shopFeatures: { maintenance: true }, maintenanceFeaturesScope: null,
    elements: Object.fromEntries(['planLoading', 'planContent', 'planEmpty', 'refreshBtn'].map(k => [k, element()])),
    planCache: new Map(), recommendationAddEvidence: new Set(), PLAN_CACHE_TTL_MS: 60000,
    planCacheKey: c => JSON.stringify(c), fetchVehicleHistory: () => {}, syncVehicleHistoryRefresh() {},
    setPlanCache: (key, data) => ctx.planCache.set(key, { data, ts: Date.now() }),
    renderPlan: data => renders.push(data),
    sendMessage: async request => { requests.push(request); return { vehicle: {} }; },
  };
  vm.createContext(ctx);
  vm.runInContext(extract(panel, 'function tutorialFeatureScope()', 'function syncTutorials()'), ctx);
  vm.runInContext(extract(panel, 'function canLoadMaintenancePlan()', 'function applyShopFeatures('), ctx);
  vm.runInContext(extract(panel, 'async function loadPlan(', '// Task #649: render'), ctx);
  return { ctx, requests, renders };
}
test('cold, denied, and different-location permissions cannot launch or serve a plan', async () => {
  const { ctx, requests, renders } = fixture();
  await ctx.loadPlan();
  ctx.maintenanceFeaturesScope = ctx.tutorialFeatureScope();
  ctx.shopFeatures.maintenance = false;
  await ctx.loadPlan(true);
  ctx.shopFeatures.maintenance = true;
  ctx.currentContext = { ...ctx.currentContext, shopId: 'location-b' };
  await ctx.loadPlan();
  assert.equal(requests.length, 0);
  assert.equal(renders.length, 0);
});
test('confirmed Maintenance sends an immutable tab/location context and rejects late results', async () => {
  const { ctx, requests, renders } = fixture();
  ctx.maintenanceFeaturesScope = ctx.tutorialFeatureScope();
  await ctx.loadPlan();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].context._tabId, 4);
  assert.notEqual(requests[0].context, ctx.currentContext);
  assert.equal(renders.length, 1);
  ctx.sendMessage = async () => {
    ctx.currentContext = { ...ctx.currentContext, shopId: 'location-b' };
    return { vehicle: { vin: 'stale' } };
  };
  await ctx.loadPlan(true);
  assert.equal(renders.length, 1);
  assert.equal(requests[0].context.shopId, 'location-a');
});
test('worker uses scoped Shopmonkey session for plans; missing context cannot fall back to root', async () => {
  let scoped = 0, root = 0;
  const ctx = {
    URL, _stateReady: Promise.resolve(), mosAuthSource: 'explicit',
    stickerLocationRequest: async context => {
      scoped++;
      assert.equal(context._tabId, 4);
      return { request: async endpoint => ({ endpoint }) };
    },
    ensureBootstrapBoundToActiveTab: async () => { root++; throw new Error('root forbidden'); },
  };
  vm.createContext(ctx);
  // Extract the complete function by balancing braces with the next declaration boundary.
  const start = background.indexOf('async function handleMosApiRequest(');
  const end = background.indexOf('\nasync function ', start + 1);
  vm.runInContext(background.slice(start, end), ctx);
  const endpoint = '/api/extension/plan?provider=shopmonkey&shopId=location-a';
  const result = await ctx.handleMosApiRequest(endpoint, {
    context: { provider: 'shopmonkey', shopId: 'location-a', _tabId: 4 },
  });
  assert.equal(result.endpoint, endpoint);
  await assert.rejects(ctx.handleMosApiRequest(endpoint), /context is required/);
  await assert.rejects(ctx.handleMosApiRequest(endpoint, {
    context: { provider: 'shopmonkey', shopId: 'location-b' },
  }), /context is required/);
  assert.equal(scoped, 1);
  assert.equal(root, 0);
});
test('plan and features use server principal canonical ownership; server retains scope and entitlement gates', () => {
  for (const file of ['app/api/extension/plan/route-handler.ts', 'app/api/extension/features/route.ts']) {
    const source = fs.readFileSync(file, 'utf8');
    if (file.includes('/plan/')) {
      assert.match(source, /providerHintIsAuthoritative: \["shopmonkey", "tekmetric"\]\.includes\(auth\.principal\?\.provider \|\| ""\)/);
    } else {
      assert.match(source, /providerHintIsAuthoritative: auth\.principal\?\.provider === "shopmonkey"/);
    }
    assert.match(source, /requireExtensionPrincipalScope\(auth/);
  }
  const source = fs.readFileSync('app/api/extension/plan/route-handler.ts', 'utf8');
  assert.match(source, /checkShopFeatureGate\(mosShopId, \["maintenance"\]/);
  assert.match(panel, /if \(canLoadMaintenancePlan\(\) && !vin/);
  assert.match(panel, /if \(canLoadMaintenancePlan\(\) && currentContext/);
});
