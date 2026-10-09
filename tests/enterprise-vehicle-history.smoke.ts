import assert from "node:assert/strict";
import {
  deduplicateHistory, eventIdentity, normalizeHistoryVin, reconcileHistory,
  validateHistoryPolicy, type HistoryEvent,
} from "../lib/vehicle-history/model";
import { classifyPackage, explicitJobStatus, normalizedHistoryEvent } from "../lib/vehicle-history/evidence";
import { historyBudget } from "../lib/vehicle-history/budget";
import { readEnterpriseVehicleHistory, resolveHistoryScope, type HistoryPrincipal } from "../lib/vehicle-history/service";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { readNormalizedVehicleHistory } from "../lib/data/repositories/vehicle-history";
import { readLegacyVehicleHistory, historyLegacyDependencies } from "../lib/data/repositories/vehicle-history-legacy";
import { historySettingsContext } from "../lib/vehicle-history/settings";

const vin = "1HGCM82633A004352";
const principal: HistoryPrincipal = { currentShopId: 3, email: "fixture@example.invalid", channel: "dashboard", verified: true };
const component = { key: "front_brake_pads", action: "replace" as const };
const event = (shopId: number, status: HistoryEvent["status"], date: string | null, extra: Partial<HistoryEvent> = {}): HistoryEvent => ({
  id: eventIdentity(shopId, "tekmetric", "same-ro", "same-job"),
  shopId, location: `Shop ${shopId}`, provider: "tekmetric", workOrderId: "same-ro",
  jobId: "same-job", title: "Replace front brake pads", date,
  mileage: 50000, mileageUnit: "miles", status, origin: "normalized",
  components: [component], componentsComplete: true, readOnly: true, ...extra,
});
function fixture() {
  const policy = { enabled: true, stage: "reconcile" as const, shopIds: [1,2,3], revision: 1 };
  const reads: number[] = [];
  const deps: any = {
    enabled: () => true,
    enterprises: async (id: number) => [{ id: id === 9 ? "foreign" : "enterprise", shopIds: id === 9 ? [9] : [1,2,3] }],
    policy: async () => policy,
    shop: async (id: number) => ({ shopId: id, enterpriseId: id === 9 ? "foreign" : "enterprise", name: `Shop ${id}` }),
    users: async () => [{ shopId: 3, shopIds: [1,2,3,9], role: "owner" }],
    entitlements: async () => ({ effectiveFeatures: { maintenance: true } }),
    read: async (id: number) => {
      reads.push(id);
      return { events: id === 1 ? [event(1, "completed", "2026-05-02T00:00:00.000Z")]
        : id === 2 ? [event(2, "declined", "2026-05-01T00:00:00.000Z")] : [],
        coverage: { shopId: id, name: `Shop ${id}`, state: "incomplete", fetchedAt: null, hasMore: false } };
    },
  };
  return { policy, deps, reads };
}

async function main() {
  assert.equal(normalizeHistoryVin(` ${vin.toLowerCase()} `), vin);
  for (const bad of ["", "Lookup-1234", "11111111111111111", "1HGCM82633A00435I", "1HG-CM82633A004352", null]) {
    assert.equal(normalizeHistoryVin(bad), null);
  }
  assert.throws(() => validateHistoryPolicy({ enabled: true, stage: "reconcile", shopIds: [1,1], revision: 0 }));
  assert.throws(() => validateHistoryPolicy({ enabled: true, stage: "reconcile", shopIds: [1,9], revision: -1 }));
  const decline = event(2, "declined", "2026-01-01T00:00:00.000Z");
  const completion = event(1, "completed", "2026-02-01T00:00:00.000Z");
  assert.notEqual(completion.id, decline.id, "provider ID collision across shops must survive");
  assert.equal(deduplicateHistory([completion, decline, completion]).length, 2);
  assert.equal(reconcileHistory([completion, decline])[1].resolution?.state, "completed_elsewhere");
  assert.equal(decline.resolution, undefined, "never mutate source evidence");
  for (const candidate of [
    { ...completion, status: "unknown" as const },
    { ...completion, date: null },
    { ...completion, date: "2026-01-01T23:59:59.000Z" },
    { ...completion, date: "2025-01-01T00:00:00.000Z" },
    { ...completion, componentsComplete: false },
    { ...completion, components: [{ ...component, action: "inspect" as const }] },
    { ...completion, components: [{ ...component, key: "rear_brake_pads" }] },
  ]) assert.equal(reconcileHistory([candidate, decline])[1].resolution?.state, "outstanding");
  const bundle = { ...decline, components: [component, { ...component, key: "rear_brake_pads" }] };
  assert.equal(reconcileHistory([completion, bundle])[1].resolution?.state, "partial");
  assert.equal(reconcileHistory([completion, { ...decline, componentsComplete: false }])[1].resolution?.state, "partial");
  assert.equal(reconcileHistory([completion, { ...decline, date: null }])[1].resolution?.state, "outstanding");
  assert.equal(explicitJobStatus({ authorized: true }), "unknown");
  assert.equal(explicitJobStatus({ status: "completed", authorized: false }), "declined");
  assert.equal(explicitJobStatus({ status: "open" }), "unknown");
  assert.equal(classifyPackage("Replace front brake pads", {}).complete, false);
  assert.equal(classifyPackage("Replace front brake pads", { labor: [{ name: "Replace front brake pads" }, { name: "Additional repairs" }] }).complete, false);
  for (const labor of [
    [{ name: "Inspect front brake pads" }],
    [{ name: "Inspect front brake pads" }, { name: "Replace front brake pads" }],
    [{ name: "Replace front brake pads" }, { name: "Other ambiguous work" }],
    [],
  ]) {
    const classified = classifyPackage("Replace front brake pads", { labor });
    const candidate = { ...completion, components: classified.components, componentsComplete: classified.complete };
    assert.equal(reconcileHistory([candidate, decline])[1].resolution?.state, "outstanding",
      "a replacement title must not override inspection, conflicting, or missing labor evidence");
  }
  const normalized: any = {
    shop_id: 1, provider: "tekmetric", work_order_id: "normalized-uuid",
    work_order_number: "42", job_id: "job-uuid", job_number: "1",
    job_provenance: {}, title: "Replace front brake pads", job_type: "custom",
    job_status: "completed", job_raw: { status: "completed" },
    declined_at: null, completed_at: null, closed_date: "2026-02-01",
    odometer: 40000, odometer_unit: "kilometers",
  };
  assert.equal(normalizedHistoryEvent(normalized, "Shop").status, "unknown", "normalized default is not provider proof");
  normalized.work_order_raw = { rawPayload: { postedDate: "2026-02-01", jobs: [{ id: 1, status: "completed", labor: [{ name: "Replace front brake pads" }] }] } };
  const positive = normalizedHistoryEvent(normalized, "Shop");
  assert.equal(positive.status, "completed");
  assert.equal(positive.componentsComplete, true);
  assert.equal(positive.mileageUnit, "kilometers");
  normalized.job_type = "inspection";
  assert.equal(normalizedHistoryEvent(normalized, "Shop").status, "unknown");

  const f = fixture();
  let response = await readEnterpriseVehicleHistory(principal, vin, f.deps);
  assert.equal(response.enabled, true);
  assert.deepEqual(f.reads.sort(), [1,2,3]);
  assert.equal(response.events.find(e => e.shopId === 2)?.resolution?.state, "completed_elsewhere");
  assert.equal(response.events.every(e => e.readOnly), true);
  assert.deepEqual(await readEnterpriseVehicleHistory({ ...principal, channel: "extension" }, vin, f.deps).then(r => r.events), response.events);
  const performedOnly = fixture();
  performedOnly.deps.policy = async () => ({ ...performedOnly.policy, stage: "performed" });
  const performedRead = performedOnly.deps.read;
  performedOnly.deps.read = async (id: number) => {
    const result = await performedRead(id);
    result.events.push(event(id, "unknown", null, { id: `unknown:${id}`, title: "Unverified private job" }));
    return result;
  };
  for (const channel of ["dashboard", "extension"] as const) {
    const performedView = await readEnterpriseVehicleHistory({ ...principal, channel }, vin, performedOnly.deps);
    assert.equal(performedView.events.length, 1);
    assert.equal(performedView.events[0].status, "completed");
    assert.ok(!JSON.stringify(performedView).includes("Unverified private job"));
  }
  f.policy.shopIds = [2,3]; f.policy.revision++;
  response = await readEnterpriseVehicleHistory(principal, vin, f.deps);
  assert.equal(response.events.some(e => e.shopId === 1), false, "next read cannot reuse a cached scope");
  assert.equal(response.events[0].resolution?.state, "outstanding");
  f.policy.shopIds = [1,2,3,9];
  response = await readEnterpriseVehicleHistory(principal, vin, f.deps);
  assert.equal(response.locations.some(l => l.shopId === 9), false, "same VIN in unrelated tenant excluded");
  f.deps.enterprises = async () => [{ id: "enterprise", shopIds: [1,2,3] }, { id: "duplicate", shopIds: [1,2,3] }];
  assert.equal((await resolveHistoryScope(principal, f.deps)).policy.enabled, false);
  for (const channel of ["signed", "partner"] as const) {
    const x = fixture();
    assert.equal((await readEnterpriseVehicleHistory({ ...principal, channel }, vin, x.deps)).enabled, false);
    assert.deepEqual(x.reads, []);
  }
  const disabled = fixture(); disabled.policy.enabled = false;
  assert.equal((await readEnterpriseVehicleHistory(principal, vin, disabled.deps)).enabled, false);
  assert.deepEqual(disabled.reads, []);
  const invalid = fixture();
  assert.equal((await readEnterpriseVehicleHistory(principal, "internal-id", invalid.deps)).vin, null);
  assert.deepEqual(invalid.reads, []);
  const basic = fixture();
  assert.equal((await readEnterpriseVehicleHistory({ ...principal, verified: false }, vin, basic.deps)).enabled, false);
  const missingEntitlement = fixture();
  missingEntitlement.deps.entitlements = async (id: number) => ({ effectiveFeatures: { maintenance: id !== 1 } });
  assert.equal((await readEnterpriseVehicleHistory(principal, vin, missingEntitlement.deps)).events.some(e => e.shopId === 1), false);
  const removedUser = fixture(); removedUser.deps.users = async () => [];
  assert.equal((await readEnterpriseVehicleHistory(principal, vin, removedUser.deps)).enabled, false);
  const midRead = fixture();
  const read = midRead.deps.read;
  midRead.deps.read = async (id: number) => { const r = await read(id); midRead.policy.revision++; return r; };
  assert.equal((await readEnterpriseVehicleHistory(principal, vin, midRead.deps)).events.length, 0);
  const unavailable = fixture();
  unavailable.deps.read = async () => { throw new Error("offline"); };
  response = await readEnterpriseVehicleHistory(principal, vin, unavailable.deps);
  assert.equal(response.locations.every(l => l.state === "unavailable"), true);
  assert.equal(response.events.length, 0);
  // Bounded multi-location fan-out, including the configured maximum.
  for (const count of [3, 12]) {
    const many = fixture();
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    many.policy.shopIds = ids;
    many.deps.enterprises = async () => [{ id: "enterprise", shopIds: ids }];
    many.deps.shop = async (id: number) => ({ shopId: id, enterpriseId: "enterprise", name: `Shop ${id}` });
    many.deps.users = async () => [{ shopId: 3, shopIds: ids }];
    let active = 0, peak = 0;
    many.deps.read = async (id: number) => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return { events: [], coverage: { shopId: id, name: `Shop ${id}`, state: "incomplete", hasMore: true, fetchedAt: null } };
    };
    const started = Date.now();
    const result = await readEnterpriseVehicleHistory(principal, vin, many.deps);
    assert.equal(result.locations.length, count);
    assert.ok(peak <= 2);
    assert.ok(Date.now() - started < 1000, "bounded offline fixture latency");
  }
  await assert.rejects(historyBudget(10)(() => new Promise(() => {})), /deadline/);
  const settings = fixture();
  assert.equal((await historySettingsContext(principal.email, 3, "owner", settings.deps))?.canManage, true);
  assert.equal((await historySettingsContext(principal.email, 3, "viewer", settings.deps))?.canManage, false);
  settings.deps.users = async () => [{ shopId: 3, shopIds: [3], role: "owner" }];
  assert.equal((await historySettingsContext(principal.email, 3, "owner", settings.deps))?.canManage, false,
    "a local owner cannot change a sharing policy including unassigned shops");
  // Exercise actual PG reader under normalized Mongo shadow OFF.
  process.env.WRITE_MONGO_NORMALIZED = "0";
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const dialect = new PgDialect();
  const pg = {
    transaction: async (fn: any) => fn({
      execute: async (query: any) => {
        const compiled = dialect.sqlToQuery(query);
        queries.push(compiled);
        if (compiled.sql.includes("FROM normalized_work_orders")) return [normalized];
        return [];
      },
    }),
  } as any;
  const pgHistory = await readNormalizedVehicleHistory(1, vin, "Shop 1", pg);
  assert.equal(pgHistory.events.length, 1);
  assert.ok(queries[1].params.includes(1));
  assert.ok(queries[1].params.includes(vin));
  assert.ok(queries[1].params.includes(201));
  assert.ok(queries[1].sql.includes("v.shop_id = w.shop_id"));
  assert.ok(queries[1].sql.includes("j.shop_id = w.shop_id"));
  const savedLegacy = { ...historyLegacyDependencies };
  try {
    historyLegacyDependencies.isLegacyVehiclesPgCanonical = () => true;
    historyLegacyDependencies.isProtractorOpsPgCanonical = () => true;
    historyLegacyDependencies.getMongoDb = async () => { throw new Error("Mongo must not be called in this canonical test"); };
    historyLegacyDependencies.getPgDb = () => ({
      transaction: async (fn: any) => fn({
        execute: async (query: any) => {
          const { sql: statement, params } = dialect.sqlToQuery(query);
          if (statement.startsWith("SET")) return [];
          assert.ok(params.includes(1));
          if (statement.includes("pre_normalized_vehicles")) {
            assert.ok(!statement.includes("IS NULL"));
            return [{ items: [{ serviceKey: "brake_fluid", serviceName: "Replace brake fluid", declinedAt: "2026-01-01" }] }];
          }
          if (statement.includes("protractor_deferred_work")) {
            assert.ok(params.includes(`vin:${vin}`));
            return [{ payload: { shopId: 1, vin, fetchedAt: "2026-05-01", items: [{ id: "p1", title: "Replace spark plugs", date: "2026-01-01" }] } }];
          }
          throw new Error(`Unexpected SQL: ${statement}`);
        },
      }),
    }) as any;
    const legacy = await readLegacyVehicleHistory(1, vin, "Shop 1", "protractor");
    assert.equal(legacy.events.length, 2);
    assert.equal(legacy.events[0].origin, "manual");
    assert.equal(legacy.events[1].origin, "provider_snapshot");
    assert.equal(legacy.warnings.some(w => w.includes("unavailable")), false);
  } finally { Object.assign(historyLegacyDependencies, savedLegacy); }
  const normalizedSource = readFileSync("lib/data/repositories/vehicle-history.ts", "utf8");
  assert.ok(!normalizedSource.includes("shouldShadowWriteMongo"), "PG reads cannot depend on normalized shadow");
  assert.ok(normalizedSource.includes("SET LOCAL statement_timeout"));
  assert.ok(normalizedSource.includes("j.shop_id = w.shop_id"));
  const legacySource = readFileSync("lib/data/repositories/vehicle-history-legacy.ts", "utf8");
  assert.ok(legacySource.includes("isLegacyVehiclesPgCanonical"));
  assert.ok(legacySource.includes("isProtractorOpsPgCanonical"));
  assert.ok(!legacySource.includes("OR shop_id IS NULL"), "unowned legacy VIN cannot join enterprise history");
  for (const file of ["app/api/vehicle-history/route.ts", "app/api/extension/vehicle-history/route.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("no-store"));
    assert.ok(!/export async function (POST|PUT|DELETE)/.test(source));
  }
  console.log("Enterprise vehicle history isolated regressions passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
