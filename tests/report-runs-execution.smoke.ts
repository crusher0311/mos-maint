// Isolated real PostgreSQL; never reads connection strings from the environment.
import assert from "node:assert/strict";
import postgres from "postgres";
import { userInfo } from "node:os";
import { getReportingKpis, normalizeReportingRange, ReportingQueryError } from "../lib/reporting-kpi-service";
import { executeReportDefinition } from "../lib/report-definition-compiler";
import { classifyReportFailure, redactedReportCause } from "../lib/report-run-diagnostics";
import { reportFailureText } from "../lib/report-run-failure";
import { workOrderStatusEnum } from "../lib/db/schema/normalized";

const pg = postgres({ host: "127.0.0.1", port: Number(process.argv[2] || 55439), database: "postgres", username: userInfo().username, max: 1 });
const range = { start: "2026-09-15", end: "2026-10-14" };
const definition: any = {
  version: 1, id: "isolated", name: "Hours Presented", dateRange: range,
  metrics: ["billedRevenue", "opportunityConversionRate", "declinedDeferredDollars", "soldLaborHours", "presentedLaborHours", "laborPartsMix"],
  dimensions: ["none"], comparison: { mode: "previousPeriod" }, presentation: { kind: "scorecard" },
};
const scope: any = { kind: "enterprise", shopIds: [1, 2], shops: [1, 2].map(shopId => ({ shopId, name: `Location ${shopId}` })) };
const query = (text: string, params: unknown[]) => pg.unsafe(text, params as any[]) as any;

async function main() {
  // Use the application enum: a text fixture missed invalid enum literals
  // that made the invoice-hours query fail in production (22P02).
  await pg.unsafe(`CREATE TYPE pg_temp.work_order_status AS ENUM (${workOrderStatusEnum.enumValues.map(value => `'${value}'`).join(",")})`);
  await pg`CREATE TEMP TABLE normalized_work_orders (
    id text, shop_id int, work_order_number text, status pg_temp.work_order_status, soft_delete jsonb,
    closed_date timestamptz, completed_date timestamptz, grand_total numeric,
    labor_total numeric, parts_total numeric, provenance jsonb, custom_fields jsonb,
    service_advisor_id text, service_advisor_name text
  )`;
  await pg`CREATE TEMP TABLE normalized_service_jobs (
    id text, shop_id int, work_order_id text, status text, total numeric,
    soft_delete jsonb, recommendation_id text, job_number text, labor_hours_billed numeric
  )`;
  await pg`CREATE TEMP TABLE normalized_payments (
    shop_id int, work_order_id text, status text, refunded_amount numeric, amount numeric, soft_delete jsonb
  )`;
  await pg`INSERT INTO normalized_work_orders VALUES
    ('a',1,'1','invoiced',null,'2026-10-01',null,100,60,40,'{"sourceSystem":"protractor"}','{"laborReporting":{"sold":2,"presented":3}}',null,null),
    ('b',2,'2','invoiced',null,'2026-10-02',null,200,120,80,'{"sourceSystem":"protractor"}','{"laborReporting":{"sold":4}}',null,null),
    ('c',99,'3','invoiced',null,'2026-10-02',null,9999,9999,0,'{"sourceSystem":"protractor"}','{"laborReporting":{"sold":999}}',null,null),
    ('old',1,'4','invoiced',null,'2026-09-01',null,50,30,20,'{"sourceSystem":"protractor"}','{"laborReporting":{"sold":1,"presented":1}}',null,null)`;
  await pg`INSERT INTO normalized_service_jobs VALUES
    ('j1',1,'a','completed',100,null,'r1','1',2),
    ('j2',1,'a','declined',50,null,'r2','2',1),
    ('j3',2,'b','completed',200,null,'r3','3',4)`;
  await pg`INSERT INTO normalized_payments VALUES (1,'a','refunded',10,100,null)`;
  // Reproduce the exact logged PostgreSQL grouping failure with the original projection.
  await assert.rejects(getReportingKpis(scope, normalizeReportingRange(range.start, range.end), {
    executionPlan: { stages: ["business"], dimensions: ["summary"] },
    query: (text, params) => query(text.replace("NULL::integer AS shop_id", "shop_id"), params),
  }), (error: any) => error.stage === "business" && error.cause.code === "42803");
  const execute = (def: any, authorized = scope) => executeReportDefinition(def, authorized, { serviceOptions: { query } });
  const mixed = await execute(definition);
  assert.equal(mixed.rows[0].current.billedRevenue, 290);
  assert.equal(mixed.rows[0].current.soldLaborHours, 6);
  assert.equal(mixed.rows[0].current.presentedLaborHours, 3);
  assert.equal(mixed.rows[0].current.declinedDeferredDollars, 50);
  assert.equal(mixed.rows[0].current.opportunityConversionRate, 66.7);
  assert.equal(mixed.rows[0].current.laborMixPercent, 60);
  assert.equal(mixed.rows[0].comparison?.billedRevenue, 50);
  assert.equal(mixed.rows[0].comparison?.soldLaborHours, 1);
  assert.ok(mixed.metadata.dataQuality.notes.some(note => /2\/2 ROs for sold hours; 1\/2 for presented hours/.test(note)), "independent labor coverage remains disclosed");
  const single = await execute(definition, { ...scope, kind: "shop", shopIds: [1], shops: [scope.shops[0]] });
  assert.equal(single.rows[0].current.billedRevenue, 90);
  assert.equal(single.rows[0].current.soldLaborHours, 2);
  const subset = await execute({ ...definition, locationIds: [1] });
  assert.equal(subset.rows[0].current.billedRevenue, 90);
  assert.equal(subset.rows[0].current.soldLaborHours, 2);
  assert.equal(subset.rows[0].comparison?.billedRevenue, 50);
  assert.deepEqual(subset.metadata.executedScope?.shopIds, [1]);
  const unknown = await execute(definition, { ...scope, kind: "shop", shopIds: [2], shops: [scope.shops[1]] });
  assert.equal(unknown.rows[0].current.presentedLaborHours, null, "unknown hours are not zero");
  for (const dimension of ["none", "date", "location"]) {
    const result = await execute({ ...definition, dimensions: [dimension], presentation: { kind: "table" } });
    assert.equal(result.rows.reduce((sum, row) => sum + (row.current.billedRevenue || 0), 0), 290);
  }
  const labor = await execute({ ...definition, metrics: ["soldLaborHours", "presentedLaborHours"] });
  assert.equal(labor.rows[0].current.soldLaborHours, mixed.rows[0].current.soldLaborHours);
  assert.equal(labor.rows[0].current.presentedLaborHours, mixed.rows[0].current.presentedLaborHours);
  await assert.rejects(getReportingKpis(scope, normalizeReportingRange(range.start, range.end), {
    query: () => new Promise(() => {}), deadlineAt: Date.now() + 10,
    executionPlan: { stages: ["business"], dimensions: ["summary"] },
  }), (error: any) => error.kind === "deadline" && error.stage === "business");
  await lifecycle(execute);
  // Independent invoice population, real SQL; legacy fixtures above stay intact.
  const invoiceGuid = "10000000-0000-0000-0000-000000000001";
  const invoice = { version: 1, id: invoiceGuid, date: "2026-10-01T12:00:00.000Z", sold: 2, presented: 3 };
  const provenance = { sourceSystem: "protractor", sourceIds: [{ system: "protractor", idType: "invoice_id", idValue: invoiceGuid }] };
  for (const key of ["verified", "duplicate"]) {
    await pg`INSERT INTO normalized_work_orders (id,shop_id,status,closed_date,provenance,custom_fields)
      VALUES (${key},3,'invoiced','2020-01-01',${pg.json(provenance)},${pg.json({ invoiceHours: invoice })})`;
  }
  await pg`INSERT INTO normalized_work_orders (id,shop_id,status,closed_date,provenance)
    VALUES ('open',3,'work_in_progress','2026-10-01',${pg.json({ sourceSystem: "protractor" })})`;
  const invoiceScope: any = { kind: "shop", shopIds: [3], shops: [{ shopId: 3, name: "Invoice fixture" }] };
  const invoiceDefinition = { ...definition, metrics: ["averagePresentedHoursPerInvoice", "averageSoldHoursPerInvoice"], comparison: { mode: "none" } };
  const verified = await execute(invoiceDefinition, invoiceScope);
  assert.equal(verified.rows[0].current.invoiceCount, 1, "source identity deduplicates and invoice date wins over close date");
  assert.equal(verified.rows[0].current.averageSoldHoursPerInvoice, 2);
  assert.equal(verified.rows[0].current.averagePresentedHoursPerInvoice, 3);
  for (const key of ["a-missing-copy", "z-missing-copy"]) {
    await pg`INSERT INTO normalized_work_orders (id,shop_id,status,provenance)
      VALUES (${key},3,'invoiced',${pg.json(provenance)})`;
  }
  for (const status of ["estimate", "work_in_progress"]) {
    await pg`INSERT INTO normalized_work_orders (id,shop_id,status,provenance)
      VALUES (${`unsupported-${status}`},3,${status},${pg.json({ sourceSystem: "tekmetric" })})`;
  }
  const partialDuplicates = await execute(invoiceDefinition, invoiceScope);
  assert.equal(partialDuplicates.rows[0].current.invoiceCount, 1);
  assert.equal(partialDuplicates.rows[0].current.invoicePopulationUnknown, 0);
  assert.equal(partialDuplicates.rows[0].current.averageSoldHoursPerInvoice, 2);
  assert.equal(partialDuplicates.rows[0].current.averagePresentedHoursPerInvoice, 3);
  await pg`INSERT INTO normalized_work_orders (id,shop_id,status,closed_date,provenance)
    VALUES ('unknown-date',3,'closed','2020-01-01',${pg.json({ sourceSystem: "protractor" })})`;
  const uncertain = await execute(invoiceDefinition, invoiceScope);
  assert.equal(uncertain.rows[0].current.invoicePopulationUnknown, 1, "unknown invoice dates cannot disappear behind a close-date filter");
  assert.equal(uncertain.rows[0].current.averageSoldHoursPerInvoice, null);
}

async function lifecycle(execute: (definition: any, scope: any) => Promise<any>) {
  const Module = require("module");
  const originalLoad = Module._load;
  let stored: any = null;
  const matches = (filter: any): boolean => stored && Object.entries(filter).every(([key, value]: any) => {
    if (key === "$or") return value.some(matches);
    if (value && typeof value === "object") {
      if ("$lt" in value) return stored[key] < value.$lt;
      if ("$lte" in value) return stored[key] <= value.$lte;
    }
    return stored[key] === value;
  });
  const update = (filter: any, change: any) => {
    if (!matches(filter)) return null;
    Object.assign(stored, change.$set);
    for (const key of Object.keys(change.$unset || {})) delete stored[key];
    for (const [key, value] of Object.entries(change.$inc || {})) stored[key] += value;
    return structuredClone(stored);
  };
  const collection = {
    insertOne: async (value: any) => { if (stored) throw { code: 11000 }; stored = structuredClone(value); },
    findOne: async (filter: any) => matches(filter) ? structuredClone(stored) : null,
    updateOne: async (filter: any, change: any) => update(filter, change),
    findOneAndUpdate: async (filter: any, change: any) => update(filter, change),
  };
  let fault: unknown = null;
  let effectiveScope = scope;
  const compiler = require("../lib/report-definition-compiler");
  const session = { email: "fixture@example.invalid", shopId: 1, role: "owner" };
  const mocks: Record<string, any> = {
    "@/lib/data/db": { getDb: async () => ({ collection: () => collection }) },
    "@/lib/auth": { getSession: async () => session },
    "@/lib/custom-report-api": { scopeRequest: (value: any) => value },
    "@/lib/data/repositories/custom-reports": { findCustomReport: async () => ({
      _id: "saved-fixture", ownerEmail: session.email, sharing: { visibility: "private" },
      scope: { kind: "enterprise", enterpriseId: "fixture" }, currentVersion: 2,
      versions: [{ version: 1, definition }, { version: 2, definition: { ...definition, name: "Newer version" } }],
    }) },
    "@/lib/data/repositories/reporting-subscriptions": { findReportingRecipient: async () => session },
    "@/lib/reporting-scope": { resolveReportingScope: async () => effectiveScope },
    "@/lib/report-definition-compiler": { ...compiler, executeReportDefinition: async (def: any, authorized: any, options: any) => {
      assert.equal(options.serviceOptions.deadlineMs, 300000);
      if (fault) throw fault;
      return execute(def, authorized);
    } },
  };
  Module._load = function(id: string, ...args: any[]) { return mocks[id] ?? originalLoad.call(this, id, ...args); };
  try {
    const service = require("../lib/report-run-service");
    const route = require("../app/api/reports/runs/route");
    const statusRoute = require("../app/api/reports/runs/[id]/route");
    const input = { reportId: "saved-fixture", reportVersion: 1 };
    await service.requestReportRun(session, input);
    assert.equal(stored.definition.name, "Hours Presented", "pinned version is not silently upgraded");
    const driver = Object.assign(new Error("SELECT private_customer; password=secret"), { code: "42803", routine: "check_ungrouped_columns_walker" });
    fault = new ReportingQueryError("database failure", "database", "business", driver);
    await service.processNextReportRun();
    assert.equal(stored.status, "failed");
    assert.equal(stored.attempts, 1, "deterministic SQL failures are not retried");
    assert.equal(stored.error.kind, "query");
    const reopen = await route.POST({ json: async () => ({ ...input, lookupOnly: true }) });
    const reopened = await reopen.json();
    const status = await (await statusRoute.GET({}, { params: Promise.resolve({ id: stored._id }) })).json();
    assert.deepEqual(reopened.error, status.error, "reopening retains safe failure details");
    assert.equal(reopened.error.stage, "business");
    assert.ok(reopened.error.correlationId);
    assert.match(reportFailureText(reopened.error), /Contact support.*Failed stage: business.*Support reference/);
    assert.doesNotMatch(JSON.stringify([reopened, redactedReportCause(fault)]), /private_customer|password=secret/);
    fault = new ReportingQueryError("deadline", "deadline", "labor");
    await service.requestReportRun(session, { ...input, force: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      stored.queuedAt = new Date(0);
      await service.processNextReportRun();
      assert.equal(stored.attempts, attempt);
      assert.equal(stored.status, attempt === 3 ? "failed" : "queued");
      assert.equal(stored.error.retryable, true);
      assert.equal(stored.error.stage, "labor");
    }
    assert.equal((await service.processNextReportRun()).claimed, 0, "retry limit is terminal");
    fault = null;
    await service.requestReportRun(session, { ...input, force: true });
    await service.processNextReportRun();
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.error, undefined);
    assert.equal(stored.result.rows[0].current.billedRevenue, 290);
    await service.requestReportRun(session, { ...input, force: true });
    effectiveScope = { ...scope, shopIds: [1] };
    await service.processNextReportRun();
    assert.equal(stored.status, "failed");
    assert.equal(stored.error.kind, "access", "worker rechecks authorized location membership");
    effectiveScope = scope;
    const combined = { ...definition, locationIds: [1,2], dimensions: ["location"],
      presentation: { kind: "table" }, filters: [{ dimension: "location", operator: "eq", value: "1" }] };
    stored = null;
    await service.requestReportRun(session, { definition: combined, scope: { kind: "enterprise", enterpriseId: "fixture" } });
    assert.deepEqual(stored.authorizedShopIds, [1]);
    await service.processNextReportRun();
    assert.equal(stored.status, "succeeded", "subset plus narrower dimension filter executes without reauthorization narrowing");
    assert.equal(stored.result.rows[0].current.billedRevenue, 90);
    assert.deepEqual(stored.result.metadata.executedScope.shopIds, [1]);
    const historicalId = stored._id;
    stored.authorizedShopIds = [1,2]; // pre-subset historical run identity
    assert.ok(await service.readableRunFor(session, historicalId), "historical full authorization remains readable");
    effectiveScope = { ...scope, shopIds: [1] };
    await assert.rejects(service.readableRunFor(session, historicalId), /outside|changed/);
    effectiveScope = scope;
    await assert.rejects(service.requestReportRun(session, {
      definition: { ...combined, locationIds: [2] }, scope: { kind: "enterprise", enterpriseId: "fixture" },
    }), /at least one location/);
    assert.equal(classifyReportFailure({ code: "42P01" }, "business", "ref").kind, "schema");
    const bounded = classifyReportFailure(new ReportingQueryError(
      "Invoice evidence exceeds 100,000 stored work orders. Select fewer locations.", "validation", "invoice"
    ), "query", "ref");
    assert.equal(bounded.kind, "invoice_scope_limit");
    assert.equal(bounded.stage, "invoice");
    assert.equal(bounded.retryable, false);
    assert.match(bounded.message, /Select fewer locations/);
    assert.doesNotMatch(classifyReportFailure(new Error("private SQL"), "query", "ref").message, /private SQL/);
    assert.equal(classifyReportFailure({ code: "ECONNRESET" }, "persist", "ref").retryable, true);
  } finally { Module._load = originalLoad; }
}

main().then(() => console.log("Report execution, persistence, retry and reopen: PASS"))
  .finally(() => pg.end()).catch(error => { console.error(error); process.exitCode = 1; });
