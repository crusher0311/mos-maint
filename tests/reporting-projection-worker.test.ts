import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { InvoiceProjectionWorker } from "../lib/reporting-projection/worker";
import { StoredInvoiceInventory } from "../lib/reporting-projection/source";
import { ProjectionInvalidation } from "../lib/reporting-projection/invalidation";
import { readProjection, projectionCacheToken } from "../lib/reporting-projection/reader";
import { classify, hash, LIMITS, PARSER_VERSION, type SourceDocument, type SourceInventory } from "../lib/reporting-projection/contract";
import { getReportingKpis, normalizeReportingRange } from "../lib/reporting-kpi-service";
import { reportRunCacheKey } from "../lib/data/repositories/report-runs";

const identity = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const raw = (n: number, sold = 2, deferred = 1): any => ({
  ID: identity(n), Type: "Invoice", WorkflowStage: "Invoice", InvoiceNumber: n + 1,
  InvoiceTime: "2026-09-02T12:00:00Z",
  ServicePackages: [{ ID: "sold", Status: "Completed", IsInvoicing: true,
    ServicePackageLines: [{ ID: "line", Type: "Labor", BilledHours: sold }] }],
  DeferredServicePackages: [{ ID: "declined", Status: "Deferred",
    ServicePackageLines: [{ ID: "deferred-line", Type: "Labor", Hours: deferred }] }],
});
class SyntheticSource implements SourceInventory {
  readonly channels = ["pg.normalized_work_orders", "mongo.operator_history_import_pages"];
  records: SourceDocument[] = [];
  pause: (() => Promise<void>) | null = null;
  calls = 0;
  set(raws: any[]) {
    this.records = raws.map((r, index) => ({
      key: String(index).padStart(6, "0"), digest: hash(r),
      identities: [r.ID.toLowerCase()], owner: `owner-${index}`, ambiguous: false, raws: [r],
    }));
  }
  async next(channel: string, _shop: number, after: string | null) {
    this.calls++;
    await this.pause?.();
    return channel === this.channels[0] ? this.records.find(r => after === null || r.key > after) ?? null : null;
  }
  async load(_channel: string, _shop: number, key: string) {
    return this.records.find(r => r.key === key) ?? null;
  }
}

async function main() {
  const host = process.argv[2];
  assert.ok(host?.startsWith("/tmp/reporting-worker."));
  const sql = postgres({ host, port: 5432, database: "postgres", username: process.env.USER ?? "runner", max: 4 });
  const query = async (text: string, params?: any[]) => sql.unsafe(text, params);
  try {
    const [marker] = await query("SELECT current_setting('invoice_preview.disposable',true) marker");
    assert.equal(marker.marker, "yes");
    // Minimal operational tables ONLY in disposable PostgreSQL; real production candidate
    // SQL is exercised verbatim, including invalidation triggers.
    for (const table of ["normalized_work_orders", "normalized_service_jobs", "normalized_line_items", "normalized_payments"])
      await query(`CREATE TABLE ${table}(id text PRIMARY KEY,shop_id int,provenance jsonb,raw_data jsonb)`);
    for (const table of ["protractor_work_orders", "protractor_invoices", "protractor_invoice_cache"])
      await query(`CREATE TABLE ${table}(shop_id int,${table === "protractor_work_orders" ? "work_order_id" : "invoice_id"} text,payload jsonb)`);
    await query(`CREATE TABLE invoice_repair_hold_scopes(shop_id int,provider text,revision bigint DEFAULT 0,PRIMARY KEY(shop_id,provider));
      CREATE TABLE invoice_repair_hold_reviews(id uuid PRIMARY KEY,shop_id int,provider text,scope_revision bigint,
        inventory_digest text,reviewed_at timestamptz DEFAULT clock_timestamp(),expires_at timestamptz);
      CREATE TABLE invoice_repair_holds(id uuid PRIMARY KEY,shop_id int,provider text,source_id text,resolved_at timestamptz);`);
    const migrationConnection = await sql.reserve();
    try {
      await migrationConnection.unsafe(readFileSync("scripts/reporting-projection/production-schema.sql", "utf8"));
    } finally { await migrationConnection.release(); }
    const source = new SyntheticSource();
    source.set([raw(1)]);
    const worker = new InvoiceProjectionWorker(sql, source);
    assert.equal(await worker.start(1), null);
    assert.equal((await worker.tick(randomUUID())).status, "disabled");
    assert.equal(source.calls, 0, "Disabled gate must do no source reads");
    process.env.REPORTING_INVOICE_PROJECTION_ENABLED = "true"; // retired flag must not activate either lane
    assert.equal(await worker.start(1), null);
    const { enabled: readerEnabled, builderEnabled } = await import("../lib/reporting-projection/contract");
    assert.equal(readerEnabled(), false);
    process.env.REPORTING_INVOICE_PROJECTION_BUILD_ENABLED = "true"; // synthetic process only
    assert.equal(builderEnabled(), true);
    assert.equal(readerEnabled(), false, "Shadow builder must not select customer reporting");
    process.env.REPORTING_INVOICE_PROJECTION_READ_ENABLED = "true";
    assert.equal(readerEnabled(), true);
    delete process.env.REPORTING_INVOICE_PROJECTION_BUILD_ENABLED;
    assert.equal(await worker.start(1), null, "Read activation must not start background work");
    process.env.REPORTING_INVOICE_PROJECTION_BUILD_ENABLED = "true";
    const freshWatcher = () => query(`INSERT INTO reporting_invoice.change_cursors(name,observed_at)
      VALUES('mongo',clock_timestamp()) ON CONFLICT(name) DO UPDATE SET observed_at=excluded.observed_at`);
    await freshWatcher();
    const until = async (id: string, phase: string) => {
      for (let i = 0; i < 150; i++) {
        const [b] = await query("SELECT * FROM reporting_invoice.builds WHERE id=$1", [id]);
        if (b.phase === phase) return b;
        assert.ok(!["failed", "cancelled"].includes(b.phase), JSON.stringify(b));
        await worker.tick(id, { steps: 1 });
      }
      throw Error("Synthetic worker failed to converge");
    };
    const begin = async (shop: number) => {
      const id = await worker.start(shop);
      assert.ok(id);
      return id;
    };
    // Reviews are inserted by the disposable test's separate reviewer, NEVER by worker.
    // Review insert invalidates old generation; re-enumeration must match the same bindings.
    const review = async (build: string, dispositions: Record<string, string> = {}) => {
      const b = await until(build, "project");
      const items = await query("SELECT identity FROM reporting_invoice.items WHERE build_id=$1", [build]);
      for (const item of items) {
        const refs = await query(`SELECT channel,source_key AS key,digest,owner,ambiguous FROM reporting_invoice.refs
          WHERE build_id=$1 AND identity=$2 ORDER BY channel COLLATE "C",source_key COLLATE "C"`, [build, item.identity]);
        await query(`INSERT INTO reporting_invoice.reviews(id,shop_id,identity,input_digest,inventory_digest,parser_version,
          disposition,owner_reference,accounting_reference,actor,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-owner-proof','synthetic-accounting-proof','synthetic-reviewer',clock_timestamp()+interval '5 minutes')`,
        [randomUUID(), b.shop_id, item.identity, hash(refs), b.inventory_digest, PARSER_VERSION, dispositions[item.identity] ?? "invoice"]);
      }
      await query(`INSERT INTO invoice_repair_hold_scopes VALUES($1,'protractor',0) ON CONFLICT DO NOTHING`, [b.shop_id]);
      await query(`INSERT INTO invoice_repair_hold_reviews(id,shop_id,provider,scope_revision,inventory_digest,expires_at)
        VALUES($1,$2,'protractor',0,$3,clock_timestamp()+interval '5 minutes')`, [randomUUID(), b.shop_id, b.inventory_digest]);
      assert.equal((await worker.tick(build)).status, "failed", "Review change must invalidate original generation");
      return begin(b.shop_id);
    };
    const start = new Date("2026-09-01"), end = new Date("2026-09-30T23:59:59.999Z");
    const read = (shops = [1]) => readProjection(query, shops, shops, start, end);
    const first = await begin(1);
    const tick = await worker.tick(first, { steps: 1 });
    assert.equal(tick.status, "deferred", JSON.stringify(await query("SELECT * FROM reporting_invoice.builds WHERE id=$1", [first])));
    assert.equal((await worker.start(1)), first, "Concurrent/restarted admission returns active build");
    await assert.rejects(() => read(), /unavailable/);
    await until(first, "complete");
    let result = await read();
    assert.equal(result.summary.invoicePopulationUnknown, 1);
    assert.equal(result.summary.averageSoldHoursPerInvoice, null);
    console.log("PASS disabled gate, durable deferral/restart, unreviewed population, unpublished isolation");

    const reviewed = await review(await begin(1));
    await until(reviewed, "complete");
    result = await read();
    assert.equal(result.summary.invoiceCount, 1);
    assert.equal(result.summary.averageSoldHoursPerInvoice, 2);
    assert.equal(result.summary.averagePresentedHoursPerInvoice, 3, "Deferred labor belongs to presented hours");
    assert.equal((await worker.tick(reviewed)).status, "complete", "Lost-response replay is idempotent");
    const token = await projectionCacheToken(query, [1]);
    const tokenKey = (projectionToken: string) => reportRunCacheKey({
      definition: { version: 1, metrics: ["averageSoldHoursPerInvoice"] } as any,
      scopeRequest: { kind: "shop", shopId: 1 }, authorizedShopIds: [1], projectionToken,
    });
    assert.notEqual(tokenKey(token), tokenKey(`${token}changed`));
    await assert.rejects(() => readProjection(query, [2], [1], start, end), /authorized/);
    const untouched = await query("SELECT * FROM normalized_work_orders");
    assert.equal(untouched.length, 0);

    // Exercise actual KPI integration; no legacy invoice query may run.
    const scope: any = { kind: "shop", shopIds: [1], shops: [{ shopId: 1, name: "Synthetic" }] };
    let projectionQueries = 0;
    const response = await getReportingKpis(scope, normalizeReportingRange(start.toISOString(), end.toISOString()), {
      executionPlan: { stages: ["invoice"], invoiceShopIds: [1], dimensions: [] } as any,
      query: (text: string, params: any) => {
        assert.ok(text.includes("reporting_invoice"), "No operational/fallback query allowed");
        projectionQueries++;
        return query(text, params) as any;
      },
    });
    assert.equal(response.summary.averagePresentedHoursPerInvoice, 3);
    assert.equal(projectionQueries, 1);
    console.log("PASS reviewed financial/owner binding, deferred hours, real KPI path, authorization/cache isolation");

    // Expiry without a mutation trigger still vetoes facts at read time.
    await query("ALTER TABLE reporting_invoice.reviews DISABLE TRIGGER reporting_invoice_review_invalidate");
    await query("UPDATE reporting_invoice.reviews SET reviewed_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE shop_id=1");
    await query("ALTER TABLE reporting_invoice.reviews ENABLE TRIGGER reporting_invoice_review_invalidate");
    result = await read();
    assert.equal(result.summary.invoicePopulationUnknown, 1);
    assert.equal(result.summary.averageSoldHoursPerInvoice, null);
    assert.notEqual(await projectionCacheToken(query, [1]), token);
    console.log("PASS stale financial review at read time");

    const missing = raw(2);
    delete missing.DeferredServicePackages[0].ServicePackageLines[0].Hours;
    source.set([missing]);
    const missingBuild = await review(await begin(2));
    await until(missingBuild, "complete");
    result = await read([2]);
    assert.equal(result.summary.invoiceCount, 1);
    assert.equal(result.summary.averageSoldHoursPerInvoice, 2);
    assert.equal(result.summary.averagePresentedHoursPerInvoice, null, "Missing labor is not zero");
    await assert.rejects(() => read([1, 2, 3]), /unavailable/, "No partial fleet publication");
    const beforeHold = await projectionCacheToken(query, [2]);
    await query("INSERT INTO invoice_repair_holds(id,shop_id,provider,source_id) VALUES($1,2,'protractor',NULL)", [randomUUID()]);
    await assert.rejects(() => read([2]), /unavailable/, "Hold trigger invalidates publication");
    assert.notEqual(await projectionCacheToken(query, [2]), beforeHold);
    console.log("PASS missing labor, held scopes, fleet completeness");

    // Missing dates and conflicting retained evidence cannot be cleared by review.
    const noDate = raw(20); delete noDate.InvoiceTime;
    const attestation = { disposition: "invoice" } as any;
    assert.equal(classify(2, identity(20), [noDate], ["owner"], false, attestation, true).classification, "unresolved");
    assert.equal(classify(2, identity(20), [raw(20), raw(20, 99)], ["owner"], false, attestation, true).classification, "unresolved");
    const noSold = raw(20); delete noSold.ServicePackages[0].ServicePackageLines[0].BilledHours;
    assert.equal(classify(2, identity(20), [noSold], ["owner"], false, attestation, true).sold, null);
    assert.equal(classify(2, identity(20), [raw(20)], ["owner"], false, attestation, false).classification, "unresolved");

    source.set([raw(3)]);
    const changed = await begin(3);
    await worker.tick(changed, { steps: 1 });
    source.set([raw(3, 9)]);
    await until(changed, "failed");
    const changedDuringProject = await begin(3);
    await until(changedDuringProject, "project");
    source.set([raw(3, 10)]);
    assert.equal((await worker.tick(changedDuringProject)).status, "failed");

    const concurrent = await begin(4);
    let release!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>(r => { entered = r; });
    const paused = new Promise<void>(r => { release = r; });
    source.pause = async () => { entered(); await paused; };
    const a = worker.tick(concurrent, { steps: 1 });
    await enteredPromise;
    assert.equal((await worker.tick(concurrent, { steps: 1 })).status, "busy");
    release(); await a; source.pause = null;
    const [checkpoint] = await query("SELECT document_count FROM reporting_invoice.builds WHERE id=$1", [concurrent]);
    assert.equal(checkpoint.document_count, 1);
    const abort = new AbortController(); abort.abort();
    assert.equal((await worker.tick(concurrent, { signal: abort.signal })).status, "cancelled_tick");
    await worker.cancel(concurrent);
    assert.equal((await worker.tick(concurrent)).status, "cancelled");
    console.log("PASS source rescan changes, project-time changes, concurrent workers, cancellation");

    const capped = await begin(5);
    await query("UPDATE reporting_invoice.builds SET document_count=$2 WHERE id=$1", [capped, LIMITS.documents]);
    assert.equal((await worker.tick(capped)).status, "failed");
    const slow = await begin(6);
    source.pause = () => new Promise(r => setTimeout(r, 20));
    assert.equal((await worker.tick(slow, { budgetMs: 1 })).status, "deferred");
    source.pause = null;
    assert.equal((await query("SELECT document_count FROM reporting_invoice.builds WHERE id=$1", [slow]))[0].document_count, 0);
    await assert.rejects(() => worker.tick(slow, { steps: 10000 }));
    const overcopies = await begin(7);
    await until(overcopies, "project");
    for (let i = 0; i <= LIMITS.copies; i++)
      await query(`INSERT INTO reporting_invoice.refs VALUES($1,$2,'synthetic-extra',$3,$4,NULL,false)`,
        [overcopies, identity(3), String(i), hash(i)]);
    await until(overcopies, "complete");
    assert.equal((await query("SELECT reason FROM reporting_invoice.items WHERE build_id=$1", [overcopies]))[0].reason, "copy_limit");
    console.log("PASS document, step, deadline and per-identity copy limits");

    // Source adapter against real SQL and synthetic Mongo (no credentials/network).
    const payload = raw(9);
    await query("INSERT INTO normalized_work_orders VALUES('synthetic-owner',9,$1::text::jsonb,$2::text::jsonb)",
      [JSON.stringify({ sourceSystem: "protractor", sourceIds: [{ system: "protractor", idType: "invoice_id", idValue: identity(9).toUpperCase() }] }),
        JSON.stringify({ rawPayload: payload })]);
    let page: any = { _id: "page-1", shopId: 9, invoices: [payload], digest: hash([payload]) };
    const mongo: any = {
      listCollections: () => ({ toArray: async () => [{ name: "synthetic" }] }),
      collection: () => ({ findOne: async (filter: any) => filter.$expr ? null : page }),
    };
    const adapter = new StoredInvoiceInventory(query, mongo);
    const owner = await adapter.next("pg.normalized_work_orders", 9, null);
    assert.equal(owner?.owner, "synthetic-owner");
    assert.deepEqual(owner?.identities, [identity(9)]);
    const archive = await adapter.next("mongo.operator_history_import_pages", 9, null);
    assert.deepEqual(archive?.identities, [identity(9)]);
    page.digest = "bad";
    await assert.rejects(() => adapter.next("mongo.operator_history_import_pages", 9, null), /archive_integrity/);
    const wrongOwner = classify(9, identity(9), [payload], ["one", "two"], false, {} as any, true);
    assert.equal(wrongOwner.classification, "unresolved");
    assert.equal(classify(9, identity(9), [{ ID: identity(9), Type: "WorkOrder", InvoiceNumber: 0 }],
      ["one"], false, { disposition: "noninvoice" } as any, true).classification, "noninvoice");
    console.log("PASS actual source adapter, archive checksums, mixed-case identity, conflicting owners/noninvoice");

    // An unrelated source write invalidates published views conservatively.
    await assert.rejects(() => read([7]), /unavailable/);
    // Preserve previous publication when a replacement is only partly inventoried.
    source.set([raw(30)]);
    const prior = await begin(30); await until(prior, "complete");
    const replacement = await begin(30);
    await worker.tick(replacement, { steps: 1 });
    assert.equal((await query("SELECT published FROM reporting_invoice.scopes WHERE shop_id=30"))[0].published, prior);
    await query("UPDATE reporting_invoice.builds SET verified_at=clock_timestamp()-interval '6 minutes' WHERE id=$1", [prior]);
    await assert.rejects(() => read([30]), /unavailable/, "Missed events are bounded by verification expiry");

    let event: any = { _id: { token: 1 } }, failStream = false;
    const stream: any = {
      get resumeToken() { return { token: 1 }; },
      tryNext: async () => { if (failStream) throw Error("synthetic history gap"); const next = event; event = null; return next; },
      close: async () => {},
    };
    const invalidator = new ProjectionInvalidation(sql, { watch: () => stream } as any);
    assert.equal((await invalidator.poll()).status, "invalidated");
    assert.equal((await invalidator.poll()).status, "caught_up");
    failStream = true;
    assert.equal((await invalidator.poll()).status, "stream_gap");
    assert.equal((await query("SELECT * FROM reporting_invoice.change_cursors")).length, 0);
    await invalidator.close();
    console.log("PASS durable change cursor, source invalidation, missed-stream gap fails closed");
    // Real-role migration boundary: ordinary writes succeed without any reporting grants.
    await query("CREATE ROLE projection_operational_test NOLOGIN");
    await query("GRANT USAGE ON SCHEMA public TO projection_operational_test");
    await query("GRANT INSERT,UPDATE,DELETE,SELECT,TRUNCATE ON normalized_work_orders TO projection_operational_test");
    const [beforeRole]=await query("SELECT revision FROM reporting_invoice.scopes WHERE shop_id=30");
    await sql.begin(async tx => {
      await tx.unsafe("SET LOCAL ROLE projection_operational_test");
      await tx.unsafe("INSERT INTO normalized_work_orders(id,shop_id) VALUES('role-probe',99)");
      await tx.unsafe("UPDATE normalized_work_orders SET shop_id=98 WHERE id='role-probe'");
      await tx.unsafe("DELETE FROM normalized_work_orders WHERE id='role-probe'");
      await tx.unsafe("TRUNCATE normalized_work_orders");
    });
    assert.equal((await query("SELECT id FROM normalized_work_orders WHERE id='role-probe'")).length, 0);
    const [afterRole]=await query("SELECT revision FROM reporting_invoice.scopes WHERE shop_id=30");
    assert.equal(Number(afterRole.revision),Number(beforeRole.revision)+4);
    for(const role of ["projection_operational_test","reporting_invoice_invalidator"]) {
      for(const text of [
        "UPDATE reporting_invoice.reviews SET revoked_at=now()",
        "UPDATE public.invoice_repair_holds SET resolved_at=now()",
        "DELETE FROM reporting_invoice.items",
      ]) await assert.rejects(()=>sql.begin(async tx=>{
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx.unsafe(text);
      }),(e:any)=>e.code==="42501");
    }
    await assert.rejects(()=>sql.begin(async tx=>{
      await tx.unsafe("SET LOCAL ROLE reporting_invoice_invalidator");
      await tx.unsafe("INSERT INTO public.normalized_work_orders(id,shop_id) VALUES('forbidden',1)");
    }),(e:any)=>e.code==="42501");
    const [fn]=await query(`SELECT prosecdef,proconfig,pg_get_userbyid(proowner) AS owner
      FROM pg_proc WHERE oid='reporting_invoice.invalidate_statement()'::regprocedure`);
    assert.equal(fn.prosecdef,true);
    assert.equal(fn.owner,"reporting_invoice_invalidator");
    assert.ok(fn.proconfig.includes("search_path=pg_catalog, pg_temp"));
    const [execute]=await query(`SELECT has_function_privilege('projection_operational_test',
      'reporting_invoice.invalidate_statement()','EXECUTE') AS allowed`);
    assert.equal(execute.allowed,false);
    await query("CREATE ROLE projection_builder_test NOLOGIN");
    await query("GRANT USAGE ON SCHEMA reporting_invoice TO projection_builder_test");
    await query(`GRANT SELECT,INSERT,UPDATE,DELETE ON reporting_invoice.scopes,
      reporting_invoice.builds,reporting_invoice.sources,reporting_invoice.items,
      reporting_invoice.refs,reporting_invoice.change_cursors TO projection_builder_test`);
    await query("GRANT SELECT ON reporting_invoice.reviews TO projection_builder_test");
    await sql.begin(async tx=>{
      await tx.unsafe("SET LOCAL ROLE projection_builder_test");
      await tx.unsafe("INSERT INTO reporting_invoice.scopes(shop_id) VALUES(999)");
    });
    for(const text of [
      "UPDATE public.normalized_work_orders SET shop_id=1",
      "UPDATE public.normalized_service_jobs SET shop_id=1",
      "UPDATE public.normalized_line_items SET shop_id=1",
      "UPDATE public.normalized_payments SET shop_id=1",
      "UPDATE public.invoice_repair_holds SET resolved_at=now()",
      "DELETE FROM public.invoice_repair_hold_reviews",
      "UPDATE reporting_invoice.reviews SET revoked_at=now()",
    ]) await assert.rejects(()=>sql.begin(async tx=>{
      await tx.unsafe("SET LOCAL ROLE projection_builder_test");
      await tx.unsafe(text);
    }),(e:any)=>e.code==="42501");
    const [membership]=await query(`SELECT pg_has_role('projection_builder_test',
      'reporting_invoice_invalidator','MEMBER') AS allowed`);
    assert.equal(membership.allowed,false);
    console.log("PASS restricted operational CRUD/TRUNCATE invalidates; definer cannot mutate operational/hold/review/fact records");
  } finally { await sql.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
