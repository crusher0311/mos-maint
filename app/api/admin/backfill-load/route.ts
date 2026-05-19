import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  BACKFILL_CHUNK_METRICS_COLLECTION,
  type BackfillProvider,
} from "@/lib/backfill-metrics/chunk-metrics";
import { HOST_LOAD_SAMPLES_COLLECTION } from "@/lib/backfill-metrics/host-load-sampler";
import { percentile } from "@/app/api/admin/sync-health/_shared";

export const dynamic = "force-dynamic";

const PROVIDERS: BackfillProvider[] = [
  "tekmetric",
  "tekmetric-fullpage",
  "protractor",
  "shopware",
];

function summarizeNumbers(values: number[]) {
  if (values.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

// GET /api/admin/backfill-load?windowMin=120
//
// Returns per-provider chunk wall-clock + write fan-out aggregates and the
// most recent host-load samples. Used by the admin "Backfill Load" panel
// (task #460) to size the safe cadence stagger.
export async function GET(req: Request) {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const windowMin = Math.max(5, Math.min(7 * 24 * 60, Number(url.searchParams.get("windowMin")) || 120));
  const since = new Date(Date.now() - windowMin * 60 * 1000);

  const db = await getDb();
  const chunkCol = db.collection(BACKFILL_CHUNK_METRICS_COLLECTION);
  const hostCol = db.collection(HOST_LOAD_SAMPLES_COLLECTION);

  const [chunkDocs, hostSamples] = await Promise.all([
    chunkCol
      .find({ chunkEndedAt: { $gte: since } })
      .project({
        provider: 1,
        shopId: 1,
        chunkStartedAt: 1,
        chunkEndedAt: 1,
        durationMs: 1,
        pagesProcessed: 1,
        rosProcessed: 1,
        outcome: 1,
        backoffMs: 1,
        writes: 1,
      })
      .sort({ chunkEndedAt: -1 })
      .limit(2000)
      .toArray(),
    hostCol
      .find({ sampledAt: { $gte: since } })
      .sort({ sampledAt: -1 })
      .limit(720)
      .toArray(),
  ]);

  const byProvider: Record<string, any> = {};
  for (const p of PROVIDERS) {
    byProvider[p] = {
      provider: p,
      chunks: 0,
      okChunks: 0,
      errorChunks: 0,
      duration: summarizeNumbers([]),
      rosPerChunk: summarizeNumbers([]),
      mongoWritesPerChunk: summarizeNumbers([]),
      pgWritesPerChunk: summarizeNumbers([]),
      backoffMs: summarizeNumbers([]),
      rateLimiterWaitsMs: summarizeNumbers([]),
      rateLimiterTimeoutsTotal: 0,
      rateLimiterFallbacksTotal: 0,
      retriesTotal: 0,
    };
  }

  const grouped: Record<string, any> = {};
  for (const p of PROVIDERS) {
    grouped[p] = {
      durations: [] as number[],
      ros: [] as number[],
      mongoWrites: [] as number[],
      pgWrites: [] as number[],
      backoff: [] as number[],
      rateWait: [] as number[],
    };
  }

  for (const doc of chunkDocs as any[]) {
    const p = doc.provider as string;
    if (!grouped[p]) continue;
    byProvider[p].chunks += 1;
    if (doc.outcome === "error") byProvider[p].errorChunks += 1;
    else byProvider[p].okChunks += 1;
    if (typeof doc.durationMs === "number") grouped[p].durations.push(doc.durationMs);
    if (typeof doc.rosProcessed === "number") grouped[p].ros.push(doc.rosProcessed);
    if (typeof doc.backoffMs === "number") grouped[p].backoff.push(doc.backoffMs);
    if (doc.writes) {
      if (typeof doc.writes.mongoWrites === "number")
        grouped[p].mongoWrites.push(doc.writes.mongoWrites);
      if (typeof doc.writes.pgWrites === "number")
        grouped[p].pgWrites.push(doc.writes.pgWrites);
      if (typeof doc.writes.rateLimiterWaitsMs === "number")
        grouped[p].rateWait.push(doc.writes.rateLimiterWaitsMs);
      byProvider[p].rateLimiterTimeoutsTotal += Number(doc.writes.rateLimiterTimeouts || 0);
      byProvider[p].rateLimiterFallbacksTotal += Number(doc.writes.rateLimiterFallbacks || 0);
      byProvider[p].retriesTotal += Number(doc.writes.retries || 0);
    }
  }

  for (const p of PROVIDERS) {
    byProvider[p].duration = summarizeNumbers(grouped[p].durations);
    byProvider[p].rosPerChunk = summarizeNumbers(grouped[p].ros);
    byProvider[p].mongoWritesPerChunk = summarizeNumbers(grouped[p].mongoWrites);
    byProvider[p].pgWritesPerChunk = summarizeNumbers(grouped[p].pgWrites);
    byProvider[p].backoffMs = summarizeNumbers(grouped[p].backoff);
    byProvider[p].rateLimiterWaitsMs = summarizeNumbers(grouped[p].rateWait);
  }

  // Concurrency overlap: for each chunk's [start, end] interval, count how
  // many other chunks across all providers were running at the chunk's
  // midpoint. Cheap O(n^2) — capped to 2000 docs above.
  const allIntervals = (chunkDocs as any[])
    .map((d) => ({
      start: new Date(d.chunkStartedAt).getTime(),
      end: new Date(d.chunkEndedAt).getTime(),
      provider: d.provider,
    }))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end));
  let peakConcurrent = 0;
  let sumConcurrent = 0;
  for (const iv of allIntervals) {
    const mid = (iv.start + iv.end) / 2;
    let n = 0;
    for (const other of allIntervals) {
      if (other.start <= mid && other.end >= mid) n += 1;
    }
    if (n > peakConcurrent) peakConcurrent = n;
    sumConcurrent += n;
  }
  const avgConcurrent =
    allIntervals.length > 0 ? Number((sumConcurrent / allIntervals.length).toFixed(2)) : 0;

  // Host-load summary — most recent sample + percentile rollups of the
  // window so the page can show "currently" + "p95 over last 2h".
  const cpu: number[] = [];
  const eloP95: number[] = [];
  const rss: number[] = [];
  const pgActive: number[] = [];
  for (const s of hostSamples as any[]) {
    if (typeof s?.cpu?.percent === "number") cpu.push(s.cpu.percent);
    if (typeof s?.eventLoopLagMs?.p95 === "number") eloP95.push(s.eventLoopLagMs.p95);
    if (typeof s?.memory?.rssBytes === "number") rss.push(s.memory.rssBytes);
    if (typeof s?.pg?.active === "number") pgActive.push(s.pg.active);
  }

  return NextResponse.json({
    windowMin,
    since,
    providers: PROVIDERS.map((p) => byProvider[p]),
    concurrency: {
      sampleSize: allIntervals.length,
      peakConcurrent,
      avgConcurrent,
    },
    hostLoad: {
      samples: hostSamples.length,
      latest: hostSamples[0] || null,
      cpuPercent: summarizeNumbers(cpu),
      eventLoopLagMsP95: summarizeNumbers(eloP95),
      rssBytes: summarizeNumbers(rss),
      pgActive: summarizeNumbers(pgActive),
    },
    recentChunks: (chunkDocs as any[]).slice(0, 50),
    recentHostSamples: (hostSamples as any[]).slice(0, 60),
  });
}
