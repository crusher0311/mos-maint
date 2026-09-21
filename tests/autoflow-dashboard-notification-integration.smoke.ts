import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { NextRequest } from "next/server";
import { fakeMongo } from "./helpers/autoflow-outbox-fake";
import { __deps as outboxDeps, drainAutoflowDashboardUpdates } from "../lib/autoflow-dashboard-outbox";
import { getDashboardUpdateToken } from "../lib/dashboard-updates";
import { dashboardMarkerChanged, dashboardMarkerAfterRefresh } from "../lib/dashboard-refresh";

// Load the real webhook, workflow repository, and cron handler. Only their
// business stores/upstream clients are replaced. Outbox + marker code is real.
let mongo = fakeMongo();
let now = Date.now();
outboxDeps.now = () => now;
let inserted = 0, customers = 0, fetches = 0, snapshots = 0, settingsWrites = 0;
let identityPg = false;
let failBusiness = false;
const shop: any = {
  shopId: 42,
  autoflow: { configured: true, sibling: "preserve", workflowRevision: 0 },
};
const events = {
  insertEvent: async () => {
    assert.equal(mongo.rows.length, 1, "intent exists before event persistence");
    inserted++;
    if (failBusiness) throw new Error("business write failed");
  },
};
const replaceSettings = async (
  shopId: unknown,
  mapping: unknown,
  expectedRevision: number,
) => {
  assert.equal(shopId, 42);
  assert.equal(mongo.rows.length, 1, "intent exists before settings persistence");
  settingsWrites++;
  if (failBusiness) throw new Error("business write failed");
  if (shop.autoflow.workflowRevision !== expectedRevision) {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  shop.autoflow.workflowMapping = mapping;
  shop.autoflow.workflowRevision = expectedRevision + 1;
  return { matchedCount: 1, modifiedCount: 1 };
};
const workflowDb = () => ({
  ...mongo.db,
  collection: (name: string) => name === "shops"
    ? {
        updateOne: async (_filter: unknown, update: any) =>
          replaceSettings(
            42,
            update.$set["autoflow.workflowMapping"],
            update.$set["autoflow.workflowRevision"] - 1,
          ),
      }
    : mongo.db.collection(name),
});
const originalLoad = (Module as any)._load;
(Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/data/db") return { getDb: async () => workflowDb() };
  if (request === "@/lib/data/repositories/events") return events;
  if (request === "@/lib/data/repositories/shops") return {
    findShopByShopId: async () => shop,
  };
  if (request === "@/lib/db/wave4-write-mode") return { isIdentityPgCanonical: () => identityPg };
  if (request === "@/lib/data/repositories/pg/identity") {
    return { replaceAutoflowWorkflowIfRevision: replaceSettings };
  }
  if (request === "@/lib/upsert-customer") return { upsertCustomerFromEvent: async () => { customers++; } };
  if (request === "@/lib/integrations/autoflow/client") return {
    fetchDviByInvoice: async () => { fetches++; return {}; },
    upsertDviSnapshot: async () => { snapshots++; },
  };
  if (request === "@/lib/data/repositories/dvi") return { updateDviResultCrossRef: async () => 1 };
  return originalLoad.call(this, request, parent, isMain);
};

async function run() {
  const { processAutoflowWebhookEvent } = await import("../lib/integrations/autoflow/webhook");
  const { saveAutoflowWorkflow, resetAutoflowWorkflow } = await import("../lib/data/repositories/autoflow-workflows");
  const payload = { event: "dvi_update", ticket: { invoice: "fixture-ro" } };
  const processEvent = () => processAutoflowWebhookEvent({
    db: {
      ...mongo.db,
      collection: (name: string) => name.endsWith("work_orders") || name === "shopware_repair_orders"
        ? { findOne: async () => null }
        : mongo.db.collection(name),
    },
    shop, payload, raw: JSON.stringify(payload),
  });
  let baseline: string | null = getDashboardUpdateToken(mongo.marker, 42);
  const otherShopBaseline = getDashboardUpdateToken(mongo.marker, 43);
  mongo.failNextMarkerWrite();
  await processEvent();
  assert.deepEqual([inserted, customers, fetches, snapshots], [1, 1, 1, 1]);
  assert.equal(getDashboardUpdateToken(mongo.marker, 42), baseline);
  assert.equal(mongo.rows[0].status, "ready");

  // Simulate a fresh request/process: no timer or in-memory retry registration
  // is needed; a worker only reads the durable collection.
  now += 60_000;
  await drainAutoflowDashboardUpdates(mongo.db);
  const recovered = getDashboardUpdateToken(mongo.marker, 42);
  assert(dashboardMarkerChanged(baseline, recovered), "recovered marker requests dashboard refresh");
  baseline = dashboardMarkerAfterRefresh(baseline, recovered, true, recovered);
  assert(!dashboardMarkerChanged(baseline, recovered), "successful refresh settles without polling churn");
  assert.equal(getDashboardUpdateToken(mongo.marker, 43), otherShopBaseline);
  assert.deepEqual([inserted, customers, fetches, snapshots], [1, 1, 1, 1], "retry never replays upstream work");
  assert.equal(mongo.rows.length, 0);
  assert.equal(await drainAutoflowDashboardUpdates(mongo.db), 0);

  // Failure of the ready-state write itself still ACKs the already-saved
  // webhook, with a durable prepared intent available to crash recovery.
  mongo.failNextUpdate();
  await processEvent();
  assert.equal(mongo.rows[0].status, "prepared");
  now += 60_000;
  await drainAutoflowDashboardUpdates(mongo.db);
  assert(dashboardMarkerChanged(recovered, getDashboardUpdateToken(mongo.marker, 42)));
  assert.deepEqual([inserted, customers, fetches, snapshots], [2, 2, 2, 2]);

  for (identityPg of [false, true]) {
    for (const action of ["save", "reset"] as const) {
      mongo = fakeMongo();
      const before = settingsWrites;
      const mutate = () => action === "save"
        ? saveAutoflowWorkflow(
            42,
            { active: ["Ready"], closed: [], excluded: [] },
            shop.autoflow.workflowRevision,
          )
        : resetAutoflowWorkflow(42, shop.autoflow.workflowRevision);
      mongo.failNextMarkerWrite();
      await mutate();
      assert.equal(settingsWrites, before + 1, `${action} commits once in PG=${identityPg}`);
      assert.equal(mongo.rows[0].shopId, "42");
      now += 60_000;
      await drainAutoflowDashboardUpdates(mongo.db);
      assert.equal(mongo.rows.length, 0);
      assert.equal(settingsWrites, before + 1, "retry never reapplies settings");
      assert.equal(mongo.marker.shopVersions["42"], 1);
      assert.equal(mongo.marker.shopVersions["43"], undefined);

      mongo = fakeMongo();
      mongo.failNextIndex();
      await assert.rejects(mutate, /index failure/);
      assert.equal(settingsWrites, before + 1, "reservation failure blocks mutation");
      mongo = fakeMongo();
      mongo.failNextUpdate();
      await mutate(); // Not a false save/reset failure after a durable write.
      assert.equal(mongo.rows[0].status, "prepared");
      now += 60_000;
      await drainAutoflowDashboardUpdates(mongo.db);
      assert.equal(mongo.marker.shopVersions["42"], 1);
    }
  }

  mongo = fakeMongo();
  mongo.failNextIndex();
  const eventCount = inserted;
  await assert.rejects(processEvent, /index failure/);
  assert.equal(inserted, eventCount, "reservation failure blocks all event work");
  mongo = fakeMongo();
  failBusiness = true;
  await assert.rejects(processEvent, /business write failed/);
  assert.equal(customers, 2, "business failure does not continue normalization");
  mongo = fakeMongo();
  await assert.rejects(
    resetAutoflowWorkflow(42, shop.autoflow.workflowRevision),
    /business write failed/,
  );
  failBusiness = false;

  // Compile with a lexical synthetic environment, never read/overwrite the
  // workspace's actual CRON_SECRET. Auth and real drain handler both execute.
  const filename = path.resolve("app/api/cron/autoflow-dashboard-notifications/route.ts");
  const compiled = ts.transpileModule(
    'const process = { env: { CRON_SECRET: "offline-cron-test" } };\n' + fs.readFileSync(filename, "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const routeModule = new (Module as any)(filename, module);
  routeModule.filename = filename;
  routeModule.paths = (Module as any)._nodeModulePaths(path.dirname(filename));
  routeModule._compile(compiled, filename);
  const route = routeModule.exports;
  const request = (authorization?: string) => new NextRequest("https://fixture.invalid/api/cron/autoflow-dashboard-notifications", {
    headers: authorization ? { authorization } : {},
  });
  assert.equal((await route.GET(request())).status, 401);
  assert.equal((await route.GET(request("Bearer wrong"))).status, 401);
  mongo = fakeMongo();
  mongo.failNextMarkerWrite();
  await saveAutoflowWorkflow(
    42,
    { active: ["Ready"], closed: [], excluded: [] },
    shop.autoflow.workflowRevision,
  );
  now += 60_000;
  const response = await route.GET(request("Bearer offline-cron-test"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).handled, 1);
  assert.equal(mongo.marker.shopVersions["42"], 1, "scheduled route delivers eventual refresh");
  assert.equal(mongo.rows.length, 0);
  mongo = fakeMongo();
  mongo.failNextIndex();
  assert.equal((await route.GET(request("Bearer offline-cron-test"))).status, 503);
  const { CRON_JOBS } = require("../lib/cron/jobs.cjs");
  assert(CRON_JOBS.some((job: any) => job.path === "/api/cron/autoflow-dashboard-notifications" && job.schedule === "* * * * *"));
  console.log("AutoFlow notification integration: webhook, save/reset, both stores, refresh tokens, cron auth/recovery passed");
}

run().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { (Module as any)._load = originalLoad; });