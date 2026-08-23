/**
 * Step 1 evidence script for task #376 — Tekmetric webhook latency &
 * receipt-rate measurement.
 *
 * READ-ONLY. Reports two things over the lookback window (default 7d):
 *
 *   1. Per-shop receipt counts in 24h vs 7d-daily-avg vs 30d-daily-avg, so
 *      we can see at a glance which shops have lost subscription health
 *      since the trailing-month baseline (the receipt-drop threshold the
 *      `tekmetric-webhook-health` cron now alerts on uses the same math).
 *
 *   2. Aggregate handler latency over the same windows, computed from
 *      `handlerDurationMs` — the field the webhook handler started
 *      persisting under task #376. Reports p50/p95/p99/max/count for 24h
 *      / 7d / 30d. Empty samples (older log rows from before #376) are
 *      excluded with a count, so on the first run shortly after deploy
 *      you'll see "0 samples" — that's the expected progression as new
 *      receipts accumulate.
 *
 * Run:
 *   npx tsx scripts/tekmetric-webhook-latency-measure.ts
 *   LOOKBACK_DAYS=14 npx tsx scripts/tekmetric-webhook-latency-measure.ts
 *
 * Output:
 *   - Console report
 *   - JSON dump at scripts/output/tekmetric-webhook-latency-<timestamp>.json
 *
 * Conclusion (filled in below as the deploy bakes):
 *   The handler now defers NIS dual-write + vehicle/customer enrichment +
 *   VHI rebuild trigger off the request thread (see task #376 step 3).
 *   Smoke-test wall-clock for both terminal and non-terminal RO events is
 *   under 10ms locally. Once the new build has shipped to prod, run this
 *   script and confirm 24h p95 < 3000ms (the alert threshold) and 7d
 *   p95 trends down vs the immediately-pre-deploy baseline.
 */

import { MongoClient } from "mongodb";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);

function pickPercentile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(q * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

function summarize(values: number[]): {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
} {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: pickPercentile(sorted, 0.5),
    p95: pickPercentile(sorted, 0.95),
    p99: pickPercentile(sorted, 0.99),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  };
}

async function main() {
  console.log(`[${new Date().toISOString()}] starting`);
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  if (!username || !password) {
    console.error("Missing MONGODB_USERNAME or MONGODB_PASSWORD env vars");
    process.exit(1);
  }
  const uri = `mongodb+srv://${username}:${encodeURIComponent(password)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  console.log(`[${new Date().toISOString()}] connected`);
  const db = client.db("mos-maintenance-mvp");

  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000);
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const sinceLookback = new Date(now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // --- 1. Per-shop receipt counts ---------------------------------------
  // Same shop-id extraction as the cron alerter: real shop fields only,
  // never `repairOrderId` (different ID space).
  console.log(`[${new Date().toISOString()}] aggregating per-shop receipts...`);
  const shops = await db
    .collection("shops")
    .find(
      { "tekmetric.shopId": { $exists: true } },
      { projection: { shopId: 1, name: 1, "tekmetric.shopId": 1 } as any },
    )
    .toArray();
  const tekShopIds = (shops as any[])
    .map((s) => Number(s.tekmetric.shopId))
    .filter(Boolean);

  const receiptAgg = await db
    .collection("tekmetric_webhook_logs")
    .aggregate([
      { $match: { receivedAt: { $gte: since30d } } },
      {
        $project: {
          receivedAt: 1,
          shopId: { $ifNull: ["$data.shopId", "$data.repairOrder.shopId"] },
        },
      },
      { $match: { shopId: { $in: tekShopIds } } },
      {
        $group: {
          _id: "$shopId",
          count30d: { $sum: 1 },
          count7d: {
            $sum: { $cond: [{ $gte: ["$receivedAt", since7d] }, 1, 0] },
          },
          count24h: {
            $sum: { $cond: [{ $gte: ["$receivedAt", since24h] }, 1, 0] },
          },
        },
      },
    ])
    .toArray();

  const byShop = new Map<number, any>();
  for (const r of receiptAgg as any[]) byShop.set(Number(r._id), r);

  const perShop = (shops as any[])
    .map((shop) => {
      const tekId = Number(shop.tekmetric.shopId);
      const stats = byShop.get(tekId) || {
        count24h: 0,
        count7d: 0,
        count30d: 0,
      };
      const expected7dDailyAvg = stats.count7d / 7;
      const expected30dDailyAvg = stats.count30d / 30;
      const dropVs7d =
        expected7dDailyAvg > 0
          ? stats.count24h / expected7dDailyAvg
          : null; // ratio < 1.0 means a drop
      const dropVs30d =
        expected30dDailyAvg > 0
          ? stats.count24h / expected30dDailyAvg
          : null;
      return {
        tekmetricShopId: tekId,
        mosShopId: shop.shopId,
        name: shop.name || "(unnamed)",
        count24h: stats.count24h,
        count7d: stats.count7d,
        count30d: stats.count30d,
        expected7dDailyAvg: Math.round(expected7dDailyAvg * 10) / 10,
        expected30dDailyAvg: Math.round(expected30dDailyAvg * 10) / 10,
        ratioVs7dAvg: dropVs7d,
        ratioVs30dAvg: dropVs30d,
      };
    })
    .sort((a, b) => {
      // Sort silent (count24h===0) first, then biggest drops vs 30d avg.
      if (a.count24h === 0 && b.count24h !== 0) return -1;
      if (b.count24h === 0 && a.count24h !== 0) return 1;
      const ar = a.ratioVs30dAvg ?? Infinity;
      const br = b.ratioVs30dAvg ?? Infinity;
      return ar - br;
    });

  console.log(`\n=== Per-shop receipt counts (${shops.length} Tekmetric shops) ===`);
  console.log(
    `  ${"shop".padEnd(28)} ${"24h".padStart(6)} ${"7d".padStart(7)} ${"30d".padStart(7)} ${"7d/d".padStart(7)} ${"30d/d".padStart(8)} ${"vs30d".padStart(7)}`,
  );
  for (const row of perShop) {
    const ratio30 =
      row.ratioVs30dAvg === null
        ? "—"
        : `${(row.ratioVs30dAvg * 100).toFixed(0)}%`;
    console.log(
      `  ${row.name.slice(0, 28).padEnd(28)} ${String(row.count24h).padStart(6)} ${String(row.count7d).padStart(7)} ${String(row.count30d).padStart(7)} ${String(row.expected7dDailyAvg).padStart(7)} ${String(row.expected30dDailyAvg).padStart(8)} ${ratio30.padStart(7)}`,
    );
  }
  const silentCount = perShop.filter((p) => p.count24h === 0).length;
  const dropCount = perShop.filter(
    (p) =>
      p.count24h > 0 &&
      p.ratioVs30dAvg !== null &&
      p.ratioVs30dAvg < 0.5 &&
      p.count30d >= 60,
  ).length;
  console.log(
    `  → ${silentCount} silent (zero in 24h), ${dropCount} dropped >50% vs 30d-avg (count30d≥60 floor)`,
  );

  // --- 2. Latency percentiles ------------------------------------------
  console.log(`\n[${new Date().toISOString()}] pulling handlerDurationMs samples...`);
  const latencyDocs = await db
    .collection("tekmetric_webhook_logs")
    .find(
      {
        receivedAt: { $gte: since30d },
        handlerDurationMs: { $exists: true, $ne: null },
      },
      { projection: { handlerDurationMs: 1, receivedAt: 1 } as any },
    )
    .toArray();

  const samples24h: number[] = [];
  const samples7d: number[] = [];
  const samplesLookback: number[] = [];
  const samples30d: number[] = [];
  for (const row of latencyDocs as unknown as Array<{
    handlerDurationMs: any;
    receivedAt: Date;
  }>) {
    const ms = Number(row.handlerDurationMs);
    if (!Number.isFinite(ms)) continue;
    samples30d.push(ms);
    const ts =
      row.receivedAt instanceof Date
        ? row.receivedAt.getTime()
        : Date.parse(row.receivedAt as any);
    if (!Number.isFinite(ts)) continue;
    if (ts >= sinceLookback.getTime()) samplesLookback.push(ms);
    if (ts >= since7d.getTime()) samples7d.push(ms);
    if (ts >= since24h.getTime()) samples24h.push(ms);
  }

  const latency = {
    last24h: summarize(samples24h),
    last7d: summarize(samples7d),
    last30d: summarize(samples30d),
    [`last${LOOKBACK_DAYS}d`]: summarize(samplesLookback),
  };

  console.log(`\n=== Handler latency (handlerDurationMs) ===`);
  for (const [window, s] of Object.entries(latency)) {
    if (s.count === 0) {
      console.log(`  ${window.padEnd(10)} no samples (field added by task #376; older rows excluded)`);
      continue;
    }
    console.log(
      `  ${window.padEnd(10)} n=${String(s.count).padStart(6)} p50=${String(s.p50).padStart(5)}ms p95=${String(s.p95).padStart(5)}ms p99=${String(s.p99).padStart(5)}ms max=${String(s.max).padStart(6)}ms`,
    );
  }

  // --- 3. Conclusion summary ------------------------------------------
  const conclusion: string[] = [];
  if (samples24h.length === 0 && samples7d.length === 0) {
    conclusion.push(
      "No handlerDurationMs samples yet — the deferred-work patch hasn't reached production, or no webhooks have arrived since deploy. Re-run after the next inbound webhook to populate baseline.",
    );
  } else {
    const p95_24h = latency.last24h.p95 ?? 0;
    if (p95_24h <= 500) {
      conclusion.push(
        `24h p95 = ${p95_24h}ms — well under the 500ms target the inline handler is engineered for. Defer pattern is doing its job.`,
      );
    } else if (p95_24h <= 3000) {
      conclusion.push(
        `24h p95 = ${p95_24h}ms — within the 3000ms alerting threshold but above the 500ms inline target. Investigate whether large-payload events (terminal ROs with many jobs) are still doing heavy inline work.`,
      );
    } else {
      conclusion.push(
        `24h p95 = ${p95_24h}ms — EXCEEDS the 3000ms alert threshold; the latency cron will page on next run. Likely cause: a code path was added that re-introduces inline NIS / enrichment / VHI work; check recent webhook-route diffs.`,
      );
    }
  }
  if (silentCount > 0) {
    conclusion.push(
      `${silentCount} shop(s) silent in 24h — these shops will trigger silent-shop alerts on the next webhook-health cron tick (now hourly).`,
    );
  }
  if (dropCount > 0) {
    conclusion.push(
      `${dropCount} shop(s) delivered fewer than 50% of their 30d daily-avg receipts in the last 24h — investigate whether a partial subscription failure (e.g. a single event type stopped firing) is responsible.`,
    );
  }
  console.log(`\n=== Conclusion ===`);
  for (const line of conclusion) console.log(`  • ${line}`);

  const out = {
    runAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    shopsScanned: shops.length,
    silentCount,
    dropCount,
    perShop,
    latency,
    conclusion,
  };

  const outDir = resolve(process.cwd(), "scripts", "output");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(
    outDir,
    `tekmetric-webhook-latency-${out.runAt.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outFile}`);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
