/**
 * diagnose-shop — one-command "is this shop healthy?" snapshot (task #1119).
 *
 * Usage:
 *   npx tsx scripts/diagnose-shop.ts <shopId>
 *
 * STRICTLY READ-ONLY. Dev Mongo IS the production cluster — this script
 * performs only find/count/aggregate reads, never writes or createIndex.
 *
 * Prints, in one readable pass:
 *   1. Shop identity + provider detection (integrationProvider FIRST, then
 *      legacy top-level / nested fields — nested `*.configured` alone
 *      false-reports connected shops as disconnected).
 *   2. Backfill progress using the correct per-provider completion fields
 *      (Tekmetric: progress-doc `complete`/`completed`, which can DISAGREE —
 *      both are shown; Protractor: shops-doc flag + `backfill_progress`;
 *      Shop-Ware: the historically named `ln` collection; Shopmonkey:
 *      `shopmonkey_backfill_progress`), plus last-REAL-progress time
 *      (lastCursorMoveAt / currentChunkEnd / counters — NOT lastRunAt,
 *      which bumps on no-op ticks).
 *   3. Webhook received-vs-processed delta (Protractor has processedAt;
 *      Tekmetric/AutoFlow are received-only feeds, reported as such).
 *   4. Cache-row freshness for the provider's RO cache.
 *   5. job_index / normalized_work_orders counts + recency.
 *   6. Recent unresolved ingestion errors (Postgres wave1) for this shop.
 */
import { getDb } from "../lib/mongo";

const DAY = 24 * 60 * 60 * 1000;

function ago(v: any): string {
  if (!v) return "never";
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  if (!Number.isFinite(t)) return String(v);
  const ms = Date.now() - t;
  if (ms < 0) return `in ${Math.round(-ms / 60000)}m`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 2 * DAY) return `${(ms / 3_600_000).toFixed(1)}h ago`;
  return `${(ms / DAY).toFixed(1)}d ago`;
}
function iso(v: any): string {
  if (!v) return "—";
  try { return new Date(v).toISOString(); } catch { return String(v); }
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const shopIdArg = process.argv[2];
  if (!shopIdArg) {
    console.error("Usage: npx tsx scripts/diagnose-shop.ts <shopId>");
    process.exit(1);
  }
  const shopId = Number(shopIdArg);
  const db = await getDb();
  const now = Date.now();

  // ---------------------------------------------------------------- shop
  const shop: any = await db
    .collection("shops")
    .findOne({ shopId: { $in: [shopId, String(shopId)] } });
  if (!shop) {
    console.error(`No shops doc found for shopId=${shopIdArg}`);
    process.exit(1);
  }

  // Provider detection: integrationProvider FIRST, then legacy fields.
  const provider: string | null =
    (shop.integrationProvider && String(shop.integrationProvider).toLowerCase()) ||
    (shop.tekmetricShopId || shop.tekmetric?.shopId ? "tekmetric" : null) ||
    (shop.protractor?.connectionId || shop.protractorConnectionId ? "protractor" : null) ||
    (shop.shopware?.tenantId || shop.shopwareTenantId ? "shopware" : null) ||
    (shop.shopmonkey?.locationId || shop.shopmonkeyLocationId ? "shopmonkey" : null) ||
    (shop.autoflowDomain ? "autoflow" : null);

  section(`SHOP ${shop.shopId} — ${shop.name || "(no name)"}`);
  console.log(`  provider (integrationProvider-first): ${provider ?? "UNKNOWN"}`);
  console.log(`  integrationProvider field: ${shop.integrationProvider ?? "—"}`);
  console.log(
    `  provider ids: tekmetric=${shop.tekmetricShopId ?? shop.tekmetric?.shopId ?? "—"} ` +
    `protractor=${shop.protractor?.connectionId ?? shop.protractorConnectionId ?? "—"} ` +
    `shopware=${shop.shopware?.tenantId ?? shop.shopwareTenantId ?? "—"}/${shop.shopware?.shopId ?? "—"} ` +
    `shopmonkey=${shop.shopmonkey?.locationId ?? "—"} autoflow=${shop.autoflowDomain ?? "—"}`,
  );
  console.log(`  createdAt: ${iso(shop.createdAt)}  enabledFeatures: ${JSON.stringify(shop.enabledFeatures ?? null)}`);

  // ------------------------------------------------------------ backfill
  section("BACKFILL PROGRESS");
  const shopIdVariants = [shopId, String(shopId)];
  const printProgress = (label: string, p: any, opts?: { shopsFlag?: any }) => {
    if (!p && opts?.shopsFlag === undefined) {
      console.log(`  ${label}: no progress doc`);
      return;
    }
    if (!p) {
      console.log(`  ${label}: no progress doc (shops-doc completed flag: ${JSON.stringify(opts?.shopsFlag)})`);
      return;
    }
    const flags = `complete=${p.complete ?? "—"} completed=${p.completed ?? "—"}` +
      (p.complete !== undefined && p.completed !== undefined && !!p.complete !== !!p.completed
        ? "  ⚠ FLAGS DISAGREE" : "");
    console.log(`  ${label}: ${flags}` +
      (opts?.shopsFlag !== undefined ? `  shops-doc flag=${JSON.stringify(opts.shopsFlag)}` : ""));
    console.log(
      `    lastRunAt=${iso(p.lastRunAt)} (${ago(p.lastRunAt)})  [ticks even on no-ops — not real progress]`,
    );
    // Real-progress signals (mirrors pipeline-stall-alerter's signature).
    const lastReal =
      [p.lastCursorMoveAt, p.lastChunkAt].map((d: any) => (d ? new Date(d).getTime() : 0))
        .reduce((a: number, b: number) => Math.max(a, b), 0) || null;
    console.log(
      `    last REAL progress: cursorMove=${iso(p.lastCursorMoveAt)} (${ago(p.lastCursorMoveAt)}) ` +
      `chunkEnd(cursor)=${iso(p.currentChunkEnd)}`,
    );
    console.log(
      `    counters: totalJobsIndexed=${p.totalJobsIndexed ?? "—"} totalRosProcessed=${p.totalRosProcessed ?? "—"} ` +
      `fullPage=${p.fullPageNextPage ?? "—"}/${p.fullPageTotalPages ?? "—"} prePass=${p.prePassNextPage ?? "—"}/${p.prePassTotalPages ?? "—"}`,
    );
    if (p.lastError) {
      console.log(`    ⚠ lastError (${iso(p.lastErrorAt)}, ${ago(p.lastErrorAt)}): ${String(p.lastError).slice(0, 200)}`);
    }
    if (lastReal && now - lastReal > 3 * 60 * 60 * 1000 && !(p.complete || p.completed)) {
      console.log(`    ⚠ incomplete and no real progress for ${ago(lastReal)} — possible stall`);
    }
  };

  try {
    if (!provider || provider === "tekmetric") {
      const p = await db.collection("tekmetric_backfill_progress")
        .findOne({ shopId: { $in: shopIdVariants } });
      printProgress("tekmetric_backfill_progress", p);
      // Note: Tekmetric "done" lives in the progress doc, NOT the shops doc.
    }
    if (!provider || provider === "protractor") {
      const p = await db.collection("backfill_progress")
        .findOne({ shopId: { $in: shopIdVariants } });
      printProgress("backfill_progress (protractor)", p, {
        shopsFlag: shop.protractor?.backfillComplete ?? shop.backfillComplete,
      });
    }
    if (!provider || provider === "shopware") {
      // Shop-Ware progress lives in the historically named `ln` collection
      // (what the backfill cron reads/writes); `shopware_backfill_progress`
      // also exists and is checked as a secondary source.
      const p = await db.collection("ln").findOne({ shopId: { $in: shopIdVariants } });
      const p2 = await db.collection("shopware_backfill_progress")
        .findOne({ shopId: { $in: shopIdVariants } }).catch(() => null);
      printProgress("ln (shopware)", p);
      if (p2) printProgress("shopware_backfill_progress", p2);
    }
    if (!provider || provider === "shopmonkey") {
      const p = await db.collection("shopmonkey_backfill_progress")
        .findOne({ shopId: { $in: shopIdVariants } });
      printProgress("shopmonkey_backfill_progress", p);
    }
    if (provider === "autoflow") {
      console.log("  AutoFlow is webhook-fed (no backfill loop).");
    }
  } catch (e: any) {
    console.log(`  (backfill read failed: ${e?.message})`);
  }

  // ------------------------------------------------------------ webhooks
  section("WEBHOOKS (last 24h)");
  const since24h = new Date(now - DAY);
  try {
    if (!provider || provider === "tekmetric") {
      const received = await db.collection("tekmetric_webhook_logs")
        .countDocuments({ shopId: { $in: shopIdVariants }, receivedAt: { $gte: since24h } })
        .catch(() => 0 as number);
      const last: any = await db.collection("tekmetric_webhook_logs")
        .find({ shopId: { $in: shopIdVariants } }).sort({ receivedAt: -1 }).limit(1).toArray()
        .then((r) => r[0]).catch(() => null);
      console.log(`  tekmetric: received=${received} last=${iso(last?.receivedAt)} (${ago(last?.receivedAt)})  [received-only feed — no processedAt marker]`);
      const sub: any = await db.collection("tekmetric_webhook_subscriptions")
        .findOne({ shopId: { $in: shopIdVariants } }).catch(() => null);
      if (sub) console.log(`  subscription: status=${sub.status ?? "—"} lastWebhookEventAt=${iso(sub.lastWebhookEventAt)} (${ago(sub.lastWebhookEventAt)})`);
    }
    if (!provider || provider === "protractor") {
      const base: any = { receivedAt: { $gte: since24h } };
      const shopFilter = { $or: [{ shopId: { $in: shopIdVariants } }, { connectionId: shop.protractor?.connectionId }] };
      const received = await db.collection("protractor_callback_events")
        .countDocuments({ ...base, ...shopFilter });
      const processed = await db.collection("protractor_callback_events")
        .countDocuments({ ...base, ...shopFilter, processed: true });
      const wedged = await db.collection("protractor_callback_events")
        .countDocuments({ ...shopFilter, processed: { $ne: true }, receivedAt: { $lt: new Date(now - 15 * 60 * 1000) } });
      console.log(`  protractor: received=${received} processed=${processed} delta=${received - processed}` +
        (wedged > 0 ? `  ⚠ ${wedged} unprocessed events older than 15m — possible processing wedge (attempts=0 pattern)` : ""));
    }
    if (provider === "autoflow") {
      const received = await db.collection("events")
        .countDocuments({ provider: "autoflow", shopId: { $in: shopIdVariants }, receivedAt: { $gte: since24h } })
        .catch(() => 0 as number);
      console.log(`  autoflow: received=${received}  [received-only feed]`);
    }
  } catch (e: any) {
    console.log(`  (webhook read failed: ${e?.message})`);
  }

  // ------------------------------------------------------- cache freshness
  section("PROVIDER RO CACHE FRESHNESS");
  const cacheCollections: Record<string, string> = {
    tekmetric: "tekmetric_work_orders",
    protractor: "protractor_work_orders",
    shopware: "shopware_repair_orders",
    shopmonkey: "shopmonkey_work_orders",
  };
  for (const [prov, coll] of Object.entries(cacheCollections)) {
    if (provider && provider !== prov) continue;
    try {
      const count = await db.collection(coll).countDocuments({ shopId: { $in: shopIdVariants } });
      const newest: any = await db.collection(coll)
        .find({ shopId: { $in: shopIdVariants } })
        .sort({ updatedAt: -1 }).limit(1).toArray().then((r) => r[0]);
      const ts = newest?.updatedAt ?? newest?.fetchedAt ?? newest?.receivedAt;
      console.log(`  ${coll}: rows=${count} newest=${iso(ts)} (${ago(ts)})`);
      if (count > 0 && ts && now - new Date(ts).getTime() > 3 * DAY) {
        console.log(`    ⚠ newest cache row is >3d old — ingestion may have stopped`);
      }
    } catch (e: any) {
      console.log(`  ${coll}: (read failed: ${e?.message})`);
    }
  }

  // -------------------------------------------------- indexed / normalized
  section("INDEXED & NORMALIZED DATA");
  try {
    const ji = await db.collection("job_index").countDocuments({ shopId: { $in: shopIdVariants } });
    // job_index docs carry no indexedAt/createdAt — the _id ObjectId
    // timestamp is the insertion time, so sort by _id for recency.
    const jiNewest: any = await db.collection("job_index")
      .find({ shopId: { $in: shopIdVariants } }).sort({ _id: -1 }).limit(1).toArray()
      .then((r) => r[0]).catch(() => null);
    const jiInsertedAt = jiNewest?._id?.getTimestamp?.() ?? null;
    console.log(
      `  job_index: rows=${ji} newest inserted=${iso(jiInsertedAt)} (${ago(jiInsertedAt)}) ` +
      `newest performedAt=${iso(jiNewest?.performedAt)}`,
    );
    // $or across shopId/shop_id can COLLSCAN a multi-million-doc mirror —
    // bound each count and degrade gracefully instead of hanging.
    const nwoA = await db.collection("normalized_work_orders")
      .countDocuments({ shopId: { $in: shopIdVariants } }, { maxTimeMS: 10_000 })
      .catch(() => null);
    const nwoB = await db.collection("normalized_work_orders")
      .countDocuments({ shop_id: { $in: shopIdVariants } }, { maxTimeMS: 10_000 })
      .catch(() => null);
    console.log(
      `  normalized_work_orders (mongo mirror): rows=${
        nwoA == null && nwoB == null ? "(count timed out — unindexed field)" : (nwoA ?? 0) + (nwoB ?? 0)
      }`,
    );
    if (provider === "shopmonkey" && ji === 0) {
      console.log("    note: Shopmonkey writes only normalized_* — job_index/legacy 0 is normal.");
    }
  } catch (e: any) {
    console.log(`  (read failed: ${e?.message})`);
  }

  // ------------------------------------------------------ ingestion errors
  section("RECENT UNRESOLVED INGESTION ERRORS (Postgres)");
  try {
    // wave1.ts imports "server-only" (throws under tsx) — query the table
    // directly via drizzle instead. Read-only SELECT.
    const { getDb: getPg } = await import("../lib/db/drizzle");
    const { ingestionErrors } = await import("../lib/db/schema/wave1");
    const { eq, desc } = await import("drizzle-orm");
    const rows: any[] = await getPg()
      .select()
      .from(ingestionErrors)
      .where(eq(ingestionErrors.resolved, false))
      .orderBy(desc(ingestionErrors.createdAt))
      .limit(200);
    const mine = rows.filter((r: any) =>
      r.shopId === shopId || String(r.shopId) === String(shopId) ||
      String(r.entityId ?? "").includes(String(shopId)));
    if (!mine.length) console.log("  none matching this shop (of the 200 most recent unresolved)");
    for (const e of mine.slice(0, 10)) {
      console.log(`  [${iso((e as any).createdAt)}] ${(e as any).workerType}/${(e as any).entityType} ${(e as any).entityId}: ${String((e as any).error).slice(0, 160)} (retries=${(e as any).retryCount})`);
    }
  } catch (e: any) {
    console.log(`  (pg read failed: ${e?.message})`);
  }

  console.log("\nDone. For a specific RO/VIN, run: npx tsx scripts/trace-ro.ts " + shopId + " <roNumber|VIN>");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
