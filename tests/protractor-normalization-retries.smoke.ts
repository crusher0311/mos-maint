import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getTableColumns } from "drizzle-orm";
import { normalizedWorkOrders } from "../lib/db/schema/normalized";
import * as normalizedSchema from "../lib/db/schema/normalized";
import { getTableName } from "drizzle-orm";
import { SupabaseDualWriter } from "../lib/supabase-dual-writer";
import {
  retainNormalizationIntent, claimNormalizationIntent, executeNormalizationIntent,
  assertNormalizationComplete, normalizationRetriesEnabled, type RetryDependencies,
} from "../lib/integrations/protractor/normalization-retries";

const providerId = "aaaaaaaa-1111-4111-8111-111111111111";
const payload = (version: number) => ({
  ID: providerId, WorkOrderNumber: "42", Total: version,
  Header: { LastModifiedTime: `2026-10-23T12:00:${String(version).padStart(2, "0")}Z` },
  ServiceItem: { ID: "vehicle", VIN: "1HGCM82633A004352" },
});
const ok = () => ({
  workOrder: { success: true }, serviceJobs: [], lineItems: [],
  payments: [], inspections: [], recommendations: [],
});

async function main() {
  assert.equal(normalizationRetriesEnabled(), false);
  const port = Number(process.argv[2]);
  assert.ok(port > 1024);
  const pg = postgres({ host: "127.0.0.1", port, username: userInfo().username, database: "postgres", max: 6 });
  try {
    assert.equal((await pg`select current_setting('invoice_preview.disposable',true) marker`)[0].marker, "yes");
    const installation = await pg.reserve();
    try {
      await installation.unsafe(readFileSync("docs/sql/protractor-normalization-retries.sql", "utf8"));
    } catch (error) {
      await installation.unsafe("ROLLBACK");
      throw error;
    } finally { installation.release(); }
    const columns = Object.values(getTableColumns(normalizedWorkOrders)).map(c =>
      `"${c.name}" ${/^(varchar|text|integer|boolean|jsonb|timestamp|numeric|decimal|double precision|real)/.test(c.getSQLType()) ? c.getSQLType() : "text"}${c.name === "id" ? " PRIMARY KEY" : ""}`);
    await pg.unsafe(`CREATE TABLE normalized_work_orders (${columns.join(",")}, UNIQUE(shop_id,work_order_number))`);
    await pg`CREATE TABLE retry_test_children (parent_id text PRIMARY KEY, value integer)`;
    let failure: "none" | "parent" | "child" | "throw" = "none";
    let calls = 0;
    let eligible = true;
    const deps: RetryDependencies = {
      eligible: async () => eligible ? {} : null,
      normalize: async (tx, intent) => {
        calls++;
        const result = ok();
        if (failure === "parent") return { ...result, workOrder: { success: false } };
        await new SupabaseDualWriter(drizzle(tx) as any).upsertWorkOrder({
          _id: "parent", shopId: intent.shop_id, workOrderNumber: "42",
          grandTotal: intent.payload.Total, rawPayload: intent.payload,
          provenance: { sourceSystem: "protractor", sourceIds: [
            { system: "protractor", idType: "invoice_id", idValue: intent.provider_id, isPrimary: true },
          ] },
        });
        await tx`INSERT INTO retry_test_children VALUES ('parent', ${intent.payload.Total})
          ON CONFLICT (parent_id) DO UPDATE SET value=excluded.value`;
        if (failure === "throw") throw new Error("simulated process failure before commit");
        if (failure === "child") return { ...result, lineItems: [{ success: false }] };
        return result;
      },
    };
    const state = async (id: string) => (await pg`select * from protractor_normalization_retries where id=${id}`)[0];
    const ready = async () => { await pg`update protractor_normalization_retries set available_at=clock_timestamp() where state='pending'`; };
    const run = async () => {
      const claim = await claimNormalizationIntent(pg);
      assert.ok(claim);
      await executeNormalizationIntent(pg, claim, deps);
      return claim;
    };
    for (const family of ["serviceJobs", "lineItems", "payments", "inspections", "recommendations"]) {
      assert.throws(() => assertNormalizationComplete({ ...ok(), [family]: [{ success: false }] }));
    }
    await assert.rejects(() => retainNormalizationIntent(pg, 1, providerId, { ...payload(1), ID: "bad" }));
    await assert.rejects(() => retainNormalizationIntent(pg, 1, providerId, { ...payload(1), ServiceItem: {} }));
    const first = await retainNormalizationIntent(pg, 1, providerId, payload(1));
    const duplicate = await retainNormalizationIntent(pg, 1, providerId.toUpperCase(), { ...payload(1), Header: payload(1).Header });
    assert.equal(first.id, duplicate.id);
    failure = "parent";
    await run();
    assert.equal((await state(first.id)).state, "pending");
    assert.ok(new Date((await state(first.id)).available_at).getTime() > Date.now());
    failure = "child";
    await ready(); await run();
    assert.equal((await pg`select count(*)::int n from normalized_work_orders`)[0].n, 0);
    assert.equal((await pg`select count(*)::int n from retry_test_children`)[0].n, 0);
    failure = "throw";
    await ready(); await run();
    assert.equal((await pg`select count(*)::int n from normalized_work_orders`)[0].n, 0);
    failure = "none";
    await ready(); await run();
    assert.equal((await state(first.id)).state, "completed");
    const before = calls;
    await retainNormalizationIntent(pg, 1, providerId, payload(1));
    assert.equal(await claimNormalizationIntent(pg), undefined);
    assert.equal(calls, before, "completed duplicates never replay work");

    // Crash after claim, stale token fencing, and two concurrent claimants.
    const second = await retainNormalizationIntent(pg, 1, providerId, payload(2));
    const claims = await Promise.all([claimNormalizationIntent(pg), claimNormalizationIntent(pg)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const lost = claims.find(Boolean)!;
    await pg`update protractor_normalization_retries set lease_until=clock_timestamp()-interval '1 second' where id=${second.id}`;
    const recovered = (await claimNormalizationIntent(pg))!;
    await executeNormalizationIntent(pg, lost, deps);
    assert.equal(calls, before);
    await executeNormalizationIntent(pg, recovered, deps);
    assert.equal((await state(second.id)).state, "completed");

    // Newest source wins, including when old retry was admitted first.
    const old = await retainNormalizationIntent(pg, 1, providerId, payload(3));
    const oldClaim = (await claimNormalizationIntent(pg))!;
    await retainNormalizationIntent(pg, 1, providerId, payload(4));
    const newClaim = (await claimNormalizationIntent(pg))!;
    await executeNormalizationIntent(pg, newClaim, deps);
    await executeNormalizationIntent(pg, oldClaim, deps);
    assert.equal((await state(old.id)).state, "pending");
    assert.equal((await pg`select value from retry_test_children`)[0].value, 4);
    await pg`update protractor_normalization_retries set attempts=5,available_at=clock_timestamp() where id=${old.id}`;
    await run();
    assert.equal((await state(old.id)).state, "terminal");
    await retainNormalizationIntent(pg, 1, providerId, payload(3));
    assert.equal((await state(old.id)).state, "terminal", "duplicates cannot reopen exhausted work");

    // Concurrent source generations retain the newest parent AND children.
    await retainNormalizationIntent(pg, 1, providerId, payload(5));
    await retainNormalizationIntent(pg, 1, providerId, payload(6));
    const a = (await claimNormalizationIntent(pg))!, b = (await claimNormalizationIntent(pg))!;
    await Promise.all([executeNormalizationIntent(pg, a, deps), executeNormalizationIntent(pg, b, deps)]);
    assert.equal((await pg`select value from retry_test_children`)[0].value, 6);
    assert.equal(Number((await pg`select grand_total from normalized_work_orders`)[0].grand_total), 6);
    await pg`update protractor_normalization_retries set state='terminal' where state='pending'`;

    eligible = false;
    const blocked = await retainNormalizationIntent(pg, 2, providerId, payload(7));
    const beforeBlocked = calls;
    await run();
    assert.equal((await state(blocked.id)).failure_code, "shop_ineligible");
    assert.equal(calls, beforeBlocked);
    eligible = true;
    const crashed = await retainNormalizationIntent(pg, 1, providerId, payload(8));
    await pg`update protractor_normalization_retries set state='running',attempts=6,
      lease_until=clock_timestamp()-interval '1 second' where id=${crashed.id}`;
    await claimNormalizationIntent(pg);
    assert.equal((await state(crashed.id)).state, "terminal");
    assert.ok((await pg`select * from protractor_normalization_retry_health where state='terminal'`).length);
    // Exercise the real mapper/ingestion service against actual PG as well.
    for (const table of [normalizedSchema.normalizedVehicles, normalizedSchema.normalizedCustomers,
      normalizedSchema.normalizedServiceJobs, normalizedSchema.normalizedLineItems, normalizedSchema.normalizedPayments]) {
      const cols = Object.values(getTableColumns(table)).map(c =>
        `"${c.name}" ${/^(varchar|text|integer|boolean|jsonb|timestamp|numeric|decimal|double precision|real)/.test(c.getSQLType()) ? c.getSQLType() : "text"}${c.name === "id" ? " PRIMARY KEY" : ""}`);
      await pg.unsafe(`CREATE TABLE "${getTableName(table)}" (${cols.join(",")})`);
    }
    const { NormalizedIngestionService } = await import("../lib/integrations/core/normalized-ingestion");
    const { ProtractorAdapter } = await import("../lib/integrations/protractor/normalized-adapter");
    const mongoChildren = new Map<string, any[]>();
    let failInspection = true;
    const noMongo = { collection: (name: string) => ({
      findOne: async (query: any) => {
        assert.ok(["normalized_inspections", "normalized_recommendations"].includes(name), `Unexpected Mongo read ${name}`);
        return (mongoChildren.get(name) || []).find(row =>
          (!query.workOrderId || row.workOrderId === query.workOrderId) &&
          (!query.vehicleId || row.vehicleId === query.vehicleId) &&
          row.provenance.sourceIds[0].idValue === query["provenance.sourceIds.idValue"]) || null;
      },
      insertOne: async (row: any) => {
        assert.ok(["normalized_inspections", "normalized_recommendations"].includes(name));
        const rows = mongoChildren.get(name) || [];
        rows.push(structuredClone(row)); mongoChildren.set(name, rows);
        if (name === "normalized_inspections" && failInspection) throw new Error("lost inspection acknowledgement");
      },
      updateOne: async (query: any, update: any) => {
        const row = mongoChildren.get(name)?.find(r => r._id === query._id);
        assert.ok(row); Object.assign(row, update.$set);
      },
    }) };
    const realDeps: RetryDependencies = {
      eligible: async () => ({}),
      normalize: (tx, intent) => new NormalizedIngestionService(noMongo as any, "protractor", 3, undefined, {
        localNormalizationWriter: new SupabaseDualWriter(drizzle(tx) as any, { skipVehicleEnrichment: true }),
      }, new ProtractorAdapter()).ingestWorkOrderWithAllEntities(intent.payload),
    };
    const real = await retainNormalizationIntent(pg, 3, providerId, { ...payload(9),
      Payments: [{ ID: "payment-1", Amount: 9 }],
      Inspections: [{ ID: "inspection-1" }], Recommendations: { ItemCollection: [{ ID: "rec-1", Title: "Check tires" }] },
    });
    await pg`CREATE FUNCTION reject_retry_payment() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''injected payment failure''; END'`;
    await pg`CREATE TRIGGER reject_retry_payment BEFORE INSERT ON normalized_payments
      FOR EACH ROW EXECUTE FUNCTION reject_retry_payment()`;
    await executeNormalizationIntent(pg, (await claimNormalizationIntent(pg))!, realDeps);
    assert.equal((await state(real.id)).state, "pending");
    assert.equal((await pg`select count(*)::int n from normalized_work_orders where shop_id=3`)[0].n, 0);
    await pg`DROP TRIGGER reject_retry_payment ON normalized_payments`;
    failInspection = false;
    await ready();
    await executeNormalizationIntent(pg, (await claimNormalizationIntent(pg))!, realDeps);
    assert.equal((await state(real.id)).state, "completed");
    assert.equal((await pg`select count(*)::int n from normalized_payments where shop_id=3`)[0].n, 1);
    const parent = (await pg`select id, vehicle_id from normalized_work_orders where shop_id=3`)[0];
    assert.equal(mongoChildren.get("normalized_inspections")?.length, 1);
    assert.equal(mongoChildren.get("normalized_inspections")?.[0].workOrderId, parent.id);
    assert.equal(mongoChildren.get("normalized_recommendations")?.length, 1);
    assert.equal(mongoChildren.get("normalized_recommendations")?.[0].vehicleId, parent.vehicle_id);
    await pg`update normalized_vehicles set aces_vehicle_id=123, vin_decoded=true where shop_id=3`;
    await retainNormalizationIntent(pg, 3, providerId, payload(10));
    await executeNormalizationIntent(pg, (await claimNormalizationIntent(pg))!, realDeps);
    assert.equal((await pg`select aces_vehicle_id from normalized_vehicles where shop_id=3`)[0].aces_vehicle_id, 123);
    console.log("PASS real PostgreSQL: retained intent, rollback, parent/child failures, backoff, duplicates, crashes, leases, generations, freshness, gates, terminal visibility");
  } finally { await pg.end(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
