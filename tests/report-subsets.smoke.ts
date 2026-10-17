import assert from "node:assert/strict";
import { compileReportDefinition, executeReportDefinition } from "../lib/report-definition-compiler";
import { reportRunCacheKey } from "../lib/data/repositories/report-runs";

const scope: any = { kind: "enterprise", enterpriseId: "jwt", shopIds: [1,2,3],
  shops: [1,2,3].map(shopId => ({ shopId, name: String(shopId) })) };
const definition: any = { version: 1, id: "subset", name: "Subset", dateRange: { start: "2026-09-01", end: "2026-09-02" },
  metrics: ["soldLaborHours"], dimensions: ["none"], presentation: { kind: "scorecard" }, comparison: { mode: "previousPeriod" } };
async function main() {
  for (const locationIds of [[], [99], ["1"], [1,99]]) {
    assert.throws(() => compileReportDefinition({ ...definition, locationIds }, scope), /location|scope/i);
  }
  const plan = compileReportDefinition({ ...definition, locationIds: [3,1,3] }, scope);
  assert.deepEqual(plan.definition.locationIds, [1,3]);
  assert.deepEqual(plan.executionShopIds, [1,3]);
  assert.throws(() => compileReportDefinition(plan.definition, { shopIds: [1,2] }), /outside/);
  const calls: unknown[][] = [];
  const result = await executeReportDefinition(plan.definition, scope, { serviceOptions: {
    query: async (_sql, params) => { calls.push(params); assert.ok(["{1}", "{3}"].includes(String(params[0]))); return []; },
  } });
  assert.ok(calls.length >= 2);
  assert.deepEqual(result.metadata.executedScope?.shopIds, [1,3]);
  const legacy = compileReportDefinition({ ...definition, dimensions: ["location"], presentation: { kind: "table" },
    filters: [{ dimension: "location", operator: "in", value: ["1","3"] }] }, scope);
  assert.deepEqual(legacy.executionShopIds, [1,3]);
  const base: any = { definition: plan.definition, scopeRequest: { kind: "enterprise", enterpriseId: "jwt" }, authorizedShopIds: [1,3] };
  assert.notEqual(reportRunCacheKey(base), reportRunCacheKey({ ...base, authorizedShopIds: [1] }));
  assert.notEqual(reportRunCacheKey(base), reportRunCacheKey({ ...base, scopeRequest: { kind: "enterprise", enterpriseId: "other" } }));
  console.log("Report subset validation, revocation, stage scope, comparisons and cache isolation: PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
