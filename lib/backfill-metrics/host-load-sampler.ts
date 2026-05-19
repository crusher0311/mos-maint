import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import os from "node:os";
import type { Db } from "mongodb";
import { getDb } from "@/lib/mongo";

export const HOST_LOAD_SAMPLES_COLLECTION = "host_load_samples";
const TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_INTERVAL_MS = 30_000;

interface SamplerState {
  timer: NodeJS.Timeout;
  histogram: IntervalHistogram;
  intervalMs: number;
  lastCpu?: NodeJS.CpuUsage;
  lastCpuAt?: number;
  consecutiveFailures: number;
}

let state: SamplerState | null = null;
let indexEnsured = false;

async function ensureIndex(db: Db): Promise<void> {
  if (indexEnsured) return;
  try {
    const col = db.collection(HOST_LOAD_SAMPLES_COLLECTION);
    await col.createIndex(
      { sampledAt: 1 },
      { expireAfterSeconds: TTL_SECONDS, name: "sampledAt_ttl_30d" },
    );
    await col.createIndex({ sampledAt: -1 }, { name: "sampledAt_desc" });
    indexEnsured = true;
  } catch (err: any) {
    console.warn(
      `[HostLoadSampler] failed to ensure indexes on ${HOST_LOAD_SAMPLES_COLLECTION}: ${err?.message || err}`,
    );
  }
}

async function takeSample(s: SamplerState): Promise<void> {
  const now = Date.now();
  const sampledAt = new Date(now);
  const cpuUsage = process.cpuUsage();
  const mem = process.memoryUsage();

  // CPU% over the sampling window (process-level — Render exposes this via
  // metrics, but we want a value we can correlate with chunk timing without
  // a second source).
  let cpuPercent: number | null = null;
  if (s.lastCpu && s.lastCpuAt) {
    const elapsedMicros = (now - s.lastCpuAt) * 1000;
    const usedMicros =
      cpuUsage.user - s.lastCpu.user + (cpuUsage.system - s.lastCpu.system);
    if (elapsedMicros > 0) {
      const cores = Math.max(1, os.cpus().length);
      cpuPercent = Number(((usedMicros / elapsedMicros) * 100 / cores).toFixed(2));
    }
  }
  s.lastCpu = cpuUsage;
  s.lastCpuAt = now;

  // Event-loop lag — monitorEventLoopDelay reports in nanoseconds.
  const h = s.histogram;
  const loopP50Ms = Number((h.percentile(50) / 1e6).toFixed(3));
  const loopP95Ms = Number((h.percentile(95) / 1e6).toFixed(3));
  const loopP99Ms = Number((h.percentile(99) / 1e6).toFixed(3));
  const loopMaxMs = Number((h.max / 1e6).toFixed(3));
  h.reset();

  let mongoOpcounters: Record<string, number> | null = null;
  let mongoConnections: { current?: number; available?: number } | null = null;
  let pgActiveConnections: number | null = null;
  let pgWaitingConnections: number | null = null;
  let pgIdleInTxn: number | null = null;
  let captureError: string | null = null;

  try {
    const db = await getDb();
    await ensureIndex(db);
    try {
      const ss = await db.command({ serverStatus: 1 });
      mongoOpcounters = ss?.opcounters ?? null;
      mongoConnections = ss?.connections
        ? { current: ss.connections.current, available: ss.connections.available }
        : null;
    } catch (err: any) {
      captureError = `mongo serverStatus: ${err?.message || err}`;
    }

    try {
      const { getDb: getPg } = await import("@/lib/db/drizzle");
      const { sql } = await import("drizzle-orm");
      const rows: any = await getPg().execute(
        sql`select state, count(*)::int as n
            from pg_stat_activity
            where datname = current_database()
            group by state`,
      );
      const list: Array<{ state: string | null; n: number }> = Array.isArray(rows)
        ? rows
        : rows?.rows || [];
      pgActiveConnections = 0;
      pgWaitingConnections = 0;
      pgIdleInTxn = 0;
      for (const r of list) {
        if (r.state === "active") pgActiveConnections += r.n;
        else if (r.state === "idle in transaction") pgIdleInTxn += r.n;
        else if (r.state && r.state.startsWith("waiting")) pgWaitingConnections += r.n;
      }
    } catch (err: any) {
      captureError = (captureError ? captureError + "; " : "") + `pg_stat_activity: ${err?.message || err}`;
    }

    const doc = {
      sampledAt,
      intervalMs: s.intervalMs,
      host: (() => { try { return os.hostname(); } catch { return null; } })(),
      pid: process.pid,
      cpu: {
        percent: cpuPercent,
        loadavg1: os.loadavg()[0] ?? null,
      },
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
      },
      eventLoopLagMs: {
        p50: loopP50Ms,
        p95: loopP95Ms,
        p99: loopP99Ms,
        max: loopMaxMs,
      },
      mongo: {
        opcounters: mongoOpcounters,
        connections: mongoConnections,
      },
      pg: {
        active: pgActiveConnections,
        waiting: pgWaitingConnections,
        idleInTransaction: pgIdleInTxn,
      },
      captureError,
    };

    await db.collection(HOST_LOAD_SAMPLES_COLLECTION).insertOne(doc as any);
    s.consecutiveFailures = 0;

    // Structured Better Stack log line (task #465) — mirrors the
    // `[BackfillChunkMetric]` shape so an alert query in Better Stack can
    // pattern-match on a single token and parse JSON without scraping free
    // text. The alerter cron also reads the persisted doc above, but the
    // log line lets the Better Stack UI side wire its own alert without a
    // round-trip to Mongo.
    try {
      console.log(
        "[HostLoadSample] " +
          JSON.stringify({
            sampledAt: sampledAt.toISOString(),
            cpuPercent,
            loopP50Ms,
            loopP95Ms,
            loopP99Ms,
            loopMaxMs,
            rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
            pgActive: pgActiveConnections,
            pgWaiting: pgWaitingConnections,
            pgIdleInTxn,
            mongoConnectionsCurrent: mongoConnections?.current ?? null,
          }),
      );
    } catch {}
  } catch (err: any) {
    s.consecutiveFailures += 1;
    // Quiet after the first failure to avoid log spam if Mongo is down,
    // but always shout on the first one so on-call notices.
    if (s.consecutiveFailures === 1) {
      console.warn(`[HostLoadSampler] sample insert failed: ${err?.message || err}`);
    }
  }
}

export interface StartHostLoadSamplerOptions {
  intervalMs?: number;
}

export function startHostLoadSampler(opts: StartHostLoadSamplerOptions = {}): void {
  if (state) {
    return;
  }
  const intervalMs = Math.max(5_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const s: SamplerState = {
    timer: setInterval(() => {
      takeSample(s).catch(() => {});
    }, intervalMs).unref(),
    histogram,
    intervalMs,
    consecutiveFailures: 0,
  };
  state = s;
  // Take an initial sample so we have a baseline cpuUsage delta on the next tick.
  s.lastCpu = process.cpuUsage();
  s.lastCpuAt = Date.now();
  console.log(`[HostLoadSampler] started (interval=${intervalMs}ms)`);
}

export function stopHostLoadSampler(): void {
  if (!state) return;
  clearInterval(state.timer);
  try { state.histogram.disable(); } catch {}
  state = null;
}
