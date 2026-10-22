import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { InvoiceProjectionWorker } from "../lib/reporting-projection/worker";
import { StoredInvoiceInventory } from "../lib/reporting-projection/source";
import { ProjectionInvalidation, changedShops, FEED_LIMITS } from "../lib/reporting-projection/invalidation";
import { projectionRuntime } from "../lib/reporting-projection/runtime";
import { readProjection, projectionCacheToken } from "../lib/reporting-projection/reader";
import { classify, hash, LIMITS, PARSER_VERSION, type SourceDocument, type SourceInventory } from "../lib/reporting-projection/contract";
import { getReportingKpis, normalizeReportingRange } from "../lib/reporting-kpi-service";
import { reportRunCacheKey } from "../lib/data/repositories/report-runs";
import { requireHoldCoverage } from "../lib/invoice-repair/hold-registry";

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
      const coverageId = b.shop_id === 1 ? `hold-review:${randomUUID()}` : randomUUID();
      await query(`INSERT INTO invoice_repair_hold_reviews(id,shop_id,provider,scope_revision,inventory_digest,expires_at,review_reference,actor)
        VALUES($1,$2,'protractor',0,$3,clock_timestamp()+interval '5 minutes','synthetic-review','synthetic-reviewer')`, [coverageId, b.shop_id, b.inventory_digest]);
      if (b.shop_id === 1) {
        const coverage = (id: string, shopId = b.shop_id, digest = b.inventory_digest, sources = [identity(1)]) =>
          requireHoldCoverage({ unsafe: query }, { shopId, provider: "protractor" }, sources, digest, id);
        for (const id of ["", " ", "bad\nid", "bad\0id"])
          await assert.rejects(() => coverage(id), /Invalid hold coverage review ID/);
        for (const id of [` ${coverageId}`, `${coverageId} `, "missing-review", "' OR true --"])
          await assert.rejects(() => coverage(id), /coverage review/);
        await assert.rejects(() => coverage(coverageId, 99999), /coverage review/);
        await assert.rejects(() => coverage(coverageId, b.shop_id, "f".repeat(64)), /coverage review/);
        await assert.rejects(() => coverage(coverageId, b.shop_id, b.inventory_digest, ["not-a-uuid"]));
      }
      await worker.tick(build, { steps: 1 });
      assert.equal((await query("SELECT phase FROM reporting_invoice.builds WHERE id=$1", [build]))[0].phase,
        "verify", "Review change must restart verification without discarding the inventory");
      return build;
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
    await query("INSERT INTO invoice_repair_holds(id,shop_id,provider,source_id,kind,reason_reference,created_by) VALUES($1,2,'protractor',NULL,'financial','synthetic-hold','synthetic-reviewer')", [randomUUID()]);
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

    // Reproduce pilot contention with real production trigger SQL: another
    // shop's operational write locks our scope, even with no second builder.
    source.set([raw(840)]);
    const contested = await worker.start(840);
    assert.ok(contested);
    let unlockTrigger!: () => void, triggerEntered!: () => void;
    const triggerReady = new Promise<void>(r => { triggerEntered = r; });
    const triggerWait = new Promise<void>(r => { unlockTrigger = r; });
    const operational = sql.begin(async tx => {
      await tx.unsafe("INSERT INTO public.normalized_work_orders(id,shop_id) VALUES('contention-other-shop',841)");
      triggerEntered();
      await triggerWait;
    });
    await triggerReady;
    try {
      assert.equal((await worker.tick(contested, { steps: 1 })).status, "busy");
      assert.equal((await query("SELECT document_count FROM reporting_invoice.builds WHERE id=$1", [contested]))[0].document_count, 0);
    } finally { unlockTrigger(); await operational; }
    await worker.tick(contested, { steps: 1 });
    assert.equal((await query("SELECT document_count FROM reporting_invoice.builds WHERE id=$1", [contested]))[0].document_count, 1);
    await worker.cancel(contested);
    console.log("PASS unrelated-shop operational trigger reproduces busy; checkpoint resumes without loss");

    // Deterministic round-trip count plus artificial RTT, not a production
    // performance forecast. Uses real SQL/transactions in disposable PG.
    source.set([raw(850)]);
    const latencyBuild = await worker.start(850); assert.ok(latencyBuild);
    let calls = 0;
    const rtt = 20;
    const lag = async () => { calls++; await new Promise(r => setTimeout(r, rtt)); };
    const delayedSql = {
      begin: async (fn: any) => {
        await lag(); // BEGIN
        const result = await sql.begin(tx => fn({
          unsafe: async (text: string, params?: any[]) => { await lag(); return tx.unsafe(text, params); },
        }));
        await lag(); // COMMIT acknowledgment
        return result;
      },
    } as any;
    const delayedWorker = new InvoiceProjectionWorker(delayedSql, source);
    const started = Date.now();
    await delayedWorker.tick(latencyBuild, { steps: 1 });
    const elapsed = Date.now() - started;
    assert.equal(calls, 8, "Batched inventory bookkeeping reduces twelve reporting round trips to eight");
    assert.ok(elapsed >= calls * rtt - 10);
    assert.equal((await query("SELECT document_count FROM reporting_invoice.builds WHERE id=$1", [latencyBuild]))[0].document_count, 1);
    await worker.cancel(latencyBuild);
    console.log(JSON.stringify({ diagnostic: "inventory_round_trips", calls, injectedRttMs: rtt, elapsedMs: elapsed,
      excludesSourceReads: true }));
    source.set([raw(3, 10)]); // Restore the shared fixture for the following cap tests.

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
      tryNext: async () => { if (failStream) throw Object.assign(Error("synthetic history gap"), { code: 286 }); const next = event; event = null; return next; },
      close: async () => {},
    };
    const invalidator = new ProjectionInvalidation(sql, { watch: () => stream } as any);
    assert.equal((await invalidator.poll()).status, "caught_up");
    assert.equal((await invalidator.poll()).status, "caught_up");
    failStream = true;
    assert.equal((await invalidator.poll()).status, "stream_gap");
    assert.equal((await query("SELECT * FROM reporting_invoice.change_cursors")).length, 0);
    await invalidator.close();
    console.log("PASS durable change cursor, source invalidation, missed-stream gap fails closed");

    // Real installed PG triggers remain conservative; mutations must not erase
    // an in-progress inventory, nor be treated as clearance for publication.
    source.set(Array.from({ length: 30 }, (_, i) => raw(100 + i)));
    await freshWatcher();
    const active = await begin(227);
    for (let i = 0; i < 30; i++) {
      await query("INSERT INTO normalized_work_orders(id,shop_id) VALUES($1,999)", [`traffic-${i}`]);
      await worker.tick(active, { steps: 1, inventoryOnly: true });
    }
    assert.equal((await query("SELECT document_count FROM reporting_invoice.builds WHERE id=$1", [active]))[0].document_count, 30);
    await until(active, "verify");
    await worker.tick(active, { steps: 5 });
    const beforeRetry = (await query("SELECT document_count FROM reporting_invoice.builds WHERE id=$1", [active]))[0].document_count;
    await query("INSERT INTO normalized_work_orders(id,shop_id) VALUES('verify-traffic',999)");
    await worker.tick(active, { steps: 1 });
    const [retry] = await query("SELECT * FROM reporting_invoice.builds WHERE id=$1", [active]);
    assert.equal(retry.phase, "verify");
    assert.equal(retry.cursor, null);
    assert.equal(retry.document_count, beforeRetry);
    // Simulate process restart: durable verification/inventory must be enough.
    const restarted = new InvoiceProjectionWorker(sql, source);
    assert.equal(await restarted.start(227), active);
    await until(active, "complete");
    assert.equal((await read([227])).summary.invoicePopulationUnknown, 30);
    console.log("PASS sustained PG traffic preserves inventory; revision veto restarts verification; no automatic clearance");

    // Deletes, new keys behind the cursor, project changes and expiry remain vetoes.
    source.set([raw(200), raw(201)]);
    const deleted = await begin(228);
    await until(deleted, "verify");
    source.records.pop();
    await until(deleted, "failed");
    source.set([raw(202)]);
    const expired = await begin(229);
    await until(expired, "project");
    await query("UPDATE reporting_invoice.builds SET verified_at=clock_timestamp()-interval '6 minutes' WHERE id=$1", [expired]);
    assert.equal((await worker.tick(expired)).status, "failed");
    assert.equal((await query("SELECT failure FROM reporting_invoice.builds WHERE id=$1", [expired]))[0].failure, "verification_expired");

    // Mongo stream fixture reopens strictly from the persisted token, not a local
    // cursor. Every consumed event is accounted for, including after rollback.
    const feed: any[] = [];
    const consumed: number[] = [];
    let streamError = 0;
    const feedDb: any = {
      watch: (_pipeline: any, options: any) => {
        let position = options.resumeAfter?.position ?? 0;
        let cachedToken = options.resumeAfter ?? null;
        return {
          // Matches mongodb 6.19 tryNext: events do not advance this property.
          get resumeToken() { return cachedToken; },
          tryNext: async () => {
            if (streamError) throw Object.assign(Error("synthetic stream error"), { code: streamError });
            if (position >= feed.length) { cachedToken = { position }; return null; }
            consumed.push(position);
            return { ...feed[position++], _id: { position } };
          },
          close: async () => {},
        };
      },
      listCollections: () => ({ toArray: async () => [{ name: "fixture" }] }),
      collection: () => ({ findOne: async () => null }),
    };
    await query("UPDATE reporting_invoice.change_cursors SET resume_token=$1::text::jsonb", [JSON.stringify({ position: 0 })]);
    const insert = (shop: number) => ({ operationType: "insert", fullDocument: { shopId: shop } });
    feed.push(...Array.from({ length: 350 }, () => insert(999)));
    const feedWorker = new ProjectionInvalidation(sql, feedDb);
    const [scopeBefore] = await query("SELECT revision FROM reporting_invoice.scopes WHERE shop_id=227");
    assert.equal((await feedWorker.poll()).status, "draining");
    assert.equal(consumed.length, FEED_LIMITS.events);
    assert.equal(+new Date((await query("SELECT observed_at FROM reporting_invoice.change_cursors"))[0].observed_at), 0);
    assert.equal((await query("SELECT revision FROM reporting_invoice.scopes WHERE shop_id=227"))[0].revision, scopeBefore.revision);
    await feedWorker.close();
    const secondConsumer = new ProjectionInvalidation(sql, feedDb);
    await secondConsumer.poll();
    await feedWorker.poll(); // interleaved consumers cannot rewind durable cursor
    assert.equal((await secondConsumer.poll()).status, "caught_up");
    assert.deepEqual(consumed, Array.from({ length: 350 }, (_, i) => i));
    assert.deepEqual(changedShops({ operationType: "delete", fullDocumentBeforeChange: { shopId: "227" } }), [227]);
    assert.equal(changedShops({ operationType: "delete" }), null);
    assert.equal(changedShops({ operationType: "update", fullDocument: { shopId: 999 } }), null);
    assert.deepEqual(changedShops({ operationType: "update", fullDocument: { shopId: 999 },
      fullDocumentBeforeChange: { shopId: 999 }, updateDescription: { updatedFields: { status: "open" } } }), [999]);
    assert.equal(changedShops({ operationType: "update", fullDocument: { shopId: 999 },
      fullDocumentBeforeChange: { shopId: 227 }, updateDescription: { updatedFields: { shopId: 999 } } }), null);
    feed.push({ operationType: "delete" });
    await feedWorker.poll();
    assert.notEqual((await query("SELECT revision FROM reporting_invoice.scopes WHERE shop_id=227"))[0].revision, scopeBefore.revision);

    // Inject a crash after stream consumption and cursor writes but before commit.
    feed.push(insert(227));
    const [durableBefore] = await query("SELECT resume_token FROM reporting_invoice.change_cursors");
    const crashSql: any = {
      begin: (fn: any) => sql.begin(async tx => { await fn(tx); throw Error("injected commit rollback"); }),
    };
    const crashing = new ProjectionInvalidation(crashSql, feedDb);
    await assert.rejects(() => crashing.poll(), /injected commit rollback/);
    assert.deepEqual((await query("SELECT resume_token FROM reporting_invoice.change_cursors"))[0].resume_token, durableBefore.resume_token);
    await feedWorker.poll();
    assert.equal(consumed.at(-1), consumed.at(-2), "Uncommitted event must replay");
    const beforeUnavailable = (await query("SELECT resume_token FROM reporting_invoice.change_cursors"))[0].resume_token;
    streamError = 89;
    assert.equal((await feedWorker.poll()).status, "stream_unavailable");
    assert.deepEqual((await query("SELECT resume_token FROM reporting_invoice.change_cursors"))[0].resume_token, beforeUnavailable);
    const gapBuild = await begin(230);
    streamError = 286;
    assert.equal((await feedWorker.poll()).status, "stream_gap");
    assert.equal((await query("SELECT failure FROM reporting_invoice.builds WHERE id=$1", [gapBuild]))[0].failure, "stream_gap");
    assert.equal((await query("SELECT * FROM reporting_invoice.change_cursors")).length, 0);
    streamError = 0;
    assert.equal((await feedWorker.poll()).status, "draining"); // fresh epoch replays fixture; never marks backlog fresh
    await feedWorker.close(); await secondConsumer.close();
    console.log("PASS bounded feed, exact unrelated-shop scope, deletes/moves, cursor loss, interleaved consumers and commit crash replay");

    // Runtime admits durable inventory even when every bounded drain has work.
    await query("UPDATE reporting_invoice.change_cursors SET resume_token=$1::text::jsonb", [JSON.stringify({ position: 0 })]);
    feed.push(...Array.from({ length: 1000 }, () => insert(999)));
    const runtime = projectionRuntime(sql, sql, feedDb);
    const running = await runtime.tick(231);
    assert.ok("buildId" in running);
    const [runtimeBuild] = await query("SELECT * FROM reporting_invoice.builds WHERE shop_id=231");
    assert.ok(runtimeBuild);
    assert.notEqual(runtimeBuild.phase, "complete");
    await assert.rejects(() => read([231]), /unavailable/);
    await runtime.close();
    // Four runtime ticks can poll at most eight batches. A retained backlog
    // larger than that cannot certify freshness even when every poll progresses.
    feed.length = 0; consumed.length = 0;
    feed.push(...Array.from({ length: FEED_LIMITS.events * 8 + 1 }, () => insert(999)));
    await query("UPDATE reporting_invoice.change_cursors SET resume_token=$1::text::jsonb,observed_at='epoch'",
      [JSON.stringify({ position: 0 })]);
    for (let i = 0; i < 8; i++) {
      const result = await feedWorker.poll();
      assert.equal(result.status, "draining");
      assert.ok("events" in result);
      assert.equal(result.events, FEED_LIMITS.events);
      assert.equal(+new Date((await query("SELECT observed_at FROM reporting_invoice.change_cursors"))[0].observed_at), 0);
    }
    assert.equal(consumed.length, 800);
    assert.equal((await feedWorker.poll()).status, "caught_up");
    assert.equal(consumed.length, 801);
    assert.equal(new Set(consumed).size, 801);
    assert.ok(+new Date((await query("SELECT observed_at FROM reporting_invoice.change_cursors"))[0].observed_at) > 0);
    await feedWorker.close();
    console.log("PASS eight bounded polls advance 800 events but cannot certify an 801-event backlog fresh");
    console.log("PASS runtime admission under sustained backlog without publication or fake freshness");
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
    const migrationClient = await sql.reserve();
    try { await migrationClient.unsafe(readFileSync("scripts/reporting-projection/scoped-invalidation.sql", "utf8")); }
    finally { await migrationClient.release(); }
    await query("INSERT INTO reporting_invoice.scopes(shop_id) VALUES(900),(901) ON CONFLICT DO NOTHING");
    const revisions = async () => (await query("SELECT shop_id,revision::int FROM reporting_invoice.scopes WHERE shop_id IN (900,901) ORDER BY shop_id")).map(r=>r.revision);
    let before = await revisions();
    await query("INSERT INTO normalized_work_orders(id,shop_id) VALUES('scoped-1',900),('scoped-2',900)");
    assert.deepEqual(await revisions(),[before[0]+1,before[1]],"Bulk insert only invalidates its owner once");
    before=await revisions();
    await query("UPDATE normalized_work_orders SET shop_id=901 WHERE id='scoped-1'");
    assert.deepEqual(await revisions(),before.map(n=>n+1),"Moves invalidate old and new owners");
    before=await revisions();
    await query("DELETE FROM normalized_work_orders WHERE id='scoped-1'");
    assert.deepEqual(await revisions(),[before[0],before[1]+1]);
    before=await revisions();
    await query("UPDATE normalized_work_orders SET shop_id=900 WHERE id='missing'");
    assert.deepEqual(await revisions(),before,"Empty statement does not invalidate");
    await query("INSERT INTO normalized_work_orders(id,shop_id) VALUES('unknown-owner',NULL)");
    assert.deepEqual(await revisions(),before.map(n=>n+1),"Unknown owner falls back fleet-wide");
    before=await revisions();
    await query("TRUNCATE normalized_work_orders");
    assert.deepEqual(await revisions(),before.map(n=>n+1));
    source.set([raw(900)]);
    const scopedBuild=await worker.start(900);assert.ok(scopedBuild);
    let scopedUnlock!:()=>void, scopedEntered!:()=>void;
    const scopedReady=new Promise<void>(r=>{scopedEntered=r;});
    const scopedWait=new Promise<void>(r=>{scopedUnlock=r;});
    const unrelated=sql.begin(async tx=>{
      await tx.unsafe("INSERT INTO normalized_work_orders(id,shop_id) VALUES('unrelated-write',901)");
      scopedEntered();await scopedWait;
    });
    await scopedReady;
    try { assert.equal((await worker.tick(scopedBuild,{steps:1})).status,"deferred"); }
    finally { scopedUnlock();await unrelated; }
    assert.equal((await query("SELECT document_count FROM reporting_invoice.builds WHERE id=$1",[scopedBuild]))[0].document_count,1);
    await worker.cancel(scopedBuild);
    console.log("PASS scoped invalidation bulk/move/delete/empty/unknown/truncate and unrelated open transaction");

    feed.length=0;consumed.length=0;
    feed.push(...Array.from({length:801},()=>insert(999)));
    await query("UPDATE reporting_invoice.change_cursors SET resume_token=$1::text::jsonb,observed_at='epoch'",[JSON.stringify({position:0})]);
    const feedRuntime=projectionRuntime(sql,sql,feedDb);
    const drain=await feedRuntime.catchUp({polls:8,budgetMs:15000});
    assert.equal(drain.status,"draining");assert.equal(drain.events,800);assert.equal(drain.polls,8);
    const finish=await feedRuntime.catchUp({polls:2,budgetMs:15000});
    assert.equal(finish.status,"caught_up");assert.equal(finish.events,1);
    const cancelled=AbortSignal.abort();
    assert.equal((await feedRuntime.catchUp({signal:cancelled})).polls,0);
    await assert.rejects(()=>feedRuntime.catchUp({polls:41}));
    await feedRuntime.close();
    console.log("PASS independent feed catch-up respects budgets, exact events, cancellation and truthful freshness");
    source.set([raw(910),raw(911)]);
    source.records[0].identities=[identity(910),identity(911)];
    source.records[1].identities=[identity(911),identity(912)];
    const batchBuild=await worker.start(910);assert.ok(batchBuild);
    const rollbackSql:any={begin:(fn:any)=>sql.begin(async tx=>{
      await fn(tx);throw Error("inventory_commit_rollback");
    })};
    await assert.rejects(()=>new InvoiceProjectionWorker(rollbackSql,source).tick(batchBuild,{steps:1}),
      /inventory_commit_rollback/);
    assert.equal((await query("SELECT document_count FROM reporting_invoice.builds WHERE id=$1",[batchBuild]))[0].document_count,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM reporting_invoice.refs WHERE build_id=$1",[batchBuild]))[0].n,0);
    await worker.tick(batchBuild,{steps:2});
    const [batched]=await query("SELECT document_count,identity_count,cursor FROM reporting_invoice.builds WHERE id=$1",[batchBuild]);
    assert.equal(batched.document_count,2);assert.equal(batched.identity_count,3);assert.equal(batched.cursor,source.records[1].key);
    assert.equal((await query("SELECT count(*)::int AS n FROM reporting_invoice.refs WHERE build_id=$1",[batchBuild]))[0].n,4);
    await worker.cancel(batchBuild);
    console.log("PASS atomic batched checkpoint rollback/replay, shared identities and complete references");
  } finally { await sql.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
