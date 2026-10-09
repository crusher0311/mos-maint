import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";
import { getPlatformAdminEmails } from "@/lib/super-admins";
import { BACKFILL_CHUNK_METRICS_COLLECTION } from "@/lib/backfill-metrics/chunk-metrics";
import { HOST_LOAD_SAMPLES_COLLECTION } from "@/lib/backfill-metrics/host-load-sampler";
import {
  BASELINE_WINDOW_MS,
  EVENT_LOOP_P99_MS_THRESHOLD,
  EventLoopLagHit,
  LoadAlertHit,
  P95DoubledHit,
  RECENT_WINDOW_MS,
  RateLimiterTimeoutHit,
  buildAlertKey,
  findEventLoopLagHits,
  findP95DoubledHits,
  findRateLimiterTimeoutHits,
} from "./lib";

/**
 * Backfill load alerter (task #465).
 *
 * Reads the metric collections shipped by task #460 (`backfill_chunk_metrics`
 * + `host_load_samples`), evaluates them against the safe band documented in
 * `docs/backfill-cadence-measurement.md`, and pages platform admins (the
 * existing on-call channel) when any of the three rules fires:
 *
 *   - rate_limiter_timeouts — any chunk with rateLimiterTimeouts > 0 (or
 *     limiter fail-open fallbacks) in the recent window.
 *   - event_loop_lag       — any host sample with event-loop p99 > 100ms
 *                            in the recent window.
 *   - p95_doubled          — per-provider chunk p95 ≥ 2× the prior 7-day
 *                            p95 in the recent window (with noise floor).
 *
 * The companion `backfill-chunk-speed-health` cron handles per-shop chunk
 * speed regressions (3× shop's own rolling baseline). This alerter is the
 * fleet-wide cadence guardrail — it catches "the whole pipeline got
 * slower" regressions that no single shop's 3× check would catch.
 *
 * State-based dedup: one row per alert key in `backfill_load_alerts`.
 * Re-page only when the breach set changes (new reason added, reason
 * dropped, provider scope changed). Auto-clear when nothing breaches.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Triggered daily via the in-process node-cron scheduler — registered in
 * `lib/cron/jobs.cjs` and bootstrapped by `src/instrumentation.ts`
 * whenever `ENABLE_INPROCESS_CRON=true`.
 */

export const __deps = {
  getDb,
  sendEmail,
  getPlatformAdminEmails,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALERTS_COLLECTION = "backfill_load_alerts";

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtWindowMs(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h >= 24 ? `${Math.round(h / 24)}d` : `${h}h`;
}

function renderHit(h: LoadAlertHit): string {
  if (h.reason === "rate_limiter_timeouts") {
    return `<li><strong>Rate-limiter pressure on ${escapeHtml(h.provider)}</strong> — ${
      h.totalTimeouts
    } timeout(s)${
      h.totalFallbacks > 0 ? `, ${h.totalFallbacks} fail-open fallback(s)` : ""
    } across ${h.chunksWithTimeouts}/${h.chunkCount} chunks in the last ${fmtWindowMs(
      h.windowMs,
    )}. Any non-zero fallback = the shared Tekmetric 10 RPS cap is breached and a 429 storm is possible.</li>`;
  }
  if (h.reason === "event_loop_lag") {
    return `<li><strong>Event-loop lag above ${h.thresholdMs}ms p99</strong> — ${
      h.breachCount
    }/${h.sampleCount} host samples breached in the last ${fmtWindowMs(
      h.windowMs,
    )}. Worst p99 = ${h.worstP99Ms}ms; most recent breach = ${h.latestBreachP99Ms}ms.</li>`;
  }
  return `<li><strong>${escapeHtml(h.provider)} chunk p95 doubled</strong> — recent p95 = ${fmtDurationMs(
    h.recentP95Ms,
  )} (${h.recentSampleCount} chunks), baseline p95 = ${fmtDurationMs(
    h.baselineP95Ms,
  )} (${h.baselineSampleCount} chunks), ${h.multiplier}× regression.</li>`;
}

function buildEmailHtml(hits: LoadAlertHit[], adminPanelUrl: string): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;max-width:720px">
  <h2 style="color:#b91c1c;margin:0 0 8px">Backfill load outside safe band</h2>
  <p style="color:#444;margin:0 0 12px">
    ${hits.length} rule(s) in the cadence safe band (see
    <code>docs/backfill-cadence-measurement.md</code>) tripped in the last
    ${fmtWindowMs(RECENT_WINDOW_MS)}. Investigate before the next daily backfill
    window so a regression doesn't compound.
  </p>
  <ul style="margin:0 0 16px;padding-left:20px">${hits.map(renderHit).join("")}</ul>
  <p style="margin:0 0 8px">
    <a href="${escapeHtml(adminPanelUrl)}">Open the Backfill Load admin panel →</a>
  </p>
  <p style="margin-top:16px;color:#666;font-size:13px">
    Sent by <code>/api/cron/backfill-load-alerter</code>. Dedup is state-based on
    the set of breaching rules: re-paged only when the breach set changes or
    the situation recovers and reappears. Thresholds are documented in
    <code>docs/backfill-cadence-measurement.md</code>.
  </p>
</div>`;
}

function buildSubject(hits: LoadAlertHit[]): string {
  const tags: string[] = [];
  const rl = hits.filter((h): h is RateLimiterTimeoutHit => h.reason === "rate_limiter_timeouts");
  const el = hits.find((h): h is EventLoopLagHit => h.reason === "event_loop_lag");
  const p95 = hits.filter((h): h is P95DoubledHit => h.reason === "p95_doubled");
  if (rl.length) tags.push(`rate-limiter (${rl.map((h) => h.provider).join(", ")})`);
  if (el) tags.push("event-loop lag");
  if (p95.length) tags.push(`p95 doubled (${p95.map((h) => h.provider).join(", ")})`);
  return `[MOS] Backfill load breach: ${tags.join("; ")}`;
}

function adminPanelUrl(): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_BASE_URL ||
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "https://mostools.io");
  return `${base.replace(/\/+$/, "")}/admin/backfill-load`;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
  if (expected && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await __deps.getDb();
  const now = new Date();
  const recentSince = new Date(now.getTime() - RECENT_WINDOW_MS);
  // Baseline = the 7 days immediately preceding the recent window (i.e.
  // [now - 8d, now - 1d)), NOT [now - 7d, now - 1d) which would only be
  // 6 days. Picked up in code review on task #465.
  const baselineSince = new Date(now.getTime() - RECENT_WINDOW_MS - BASELINE_WINDOW_MS);

  // Read the three signal streams in parallel.
  const chunkCol = db.collection(BACKFILL_CHUNK_METRICS_COLLECTION);
  const hostCol = db.collection(HOST_LOAD_SAMPLES_COLLECTION);
  const [recentChunksRaw, baselineChunksRaw, hostSamplesRaw] = await Promise.all([
    chunkCol
      .find(
        { chunkEndedAt: { $gte: recentSince } },
        { projection: { provider: 1, shopId: 1, chunkEndedAt: 1, durationMs: 1, writes: 1 } } as any,
      )
      .toArray(),
    chunkCol
      .find(
        { chunkEndedAt: { $gte: baselineSince, $lt: recentSince } },
        { projection: { provider: 1, chunkEndedAt: 1, durationMs: 1 } } as any,
      )
      .toArray(),
    hostCol
      .find(
        { sampledAt: { $gte: recentSince } },
        { projection: { sampledAt: 1, eventLoopLagMs: 1 } } as any,
      )
      .toArray(),
  ]);

  const toChunk = (r: any) => ({
    provider: r.provider,
    shopId: r.shopId,
    chunkEndedAt: r.chunkEndedAt instanceof Date ? r.chunkEndedAt : new Date(r.chunkEndedAt),
    durationMs: Number(r.durationMs),
    writes: r.writes ?? null,
  });
  const toHost = (r: any) => ({
    sampledAt: r.sampledAt instanceof Date ? r.sampledAt : new Date(r.sampledAt),
    eventLoopLagMs: r.eventLoopLagMs ?? null,
  });

  const recentChunks = (recentChunksRaw as any[]).map(toChunk);
  const baselineChunks = (baselineChunksRaw as any[]).map(toChunk);
  const hostSamples = (hostSamplesRaw as any[]).map(toHost);

  const rlHits = findRateLimiterTimeoutHits(recentChunks);
  const elHit = findEventLoopLagHits(hostSamples);
  const p95Hits = findP95DoubledHits(recentChunks, baselineChunks);

  const hits: LoadAlertHit[] = [...rlHits, ...(elHit ? [elHit] : []), ...p95Hits];
  const key = buildAlertKey(hits);

  // State-based dedup. One row keyed on `_id: "global"` (rules are
  // fleet-scoped, so a single row is enough to encode the current breach
  // state). Re-page only when the key changes.
  const alertsCol = db.collection(ALERTS_COLLECTION);
  const existing = (await alertsCol.findOne({ _id: "global" as any })) as any;

  let emailed = 0;
  let action: "no_breach" | "auto_cleared" | "new_alert" | "key_changed" | "suppressed" =
    "no_breach";

  if (hits.length === 0) {
    if (existing) {
      await alertsCol.deleteOne({ _id: "global" as any });
      action = "auto_cleared";
    }
  } else if (!existing) {
    action = "new_alert";
  } else if (existing.alertKey !== key) {
    action = "key_changed";
  } else {
    action = "suppressed";
    await alertsCol.updateOne(
      { _id: "global" as any },
      { $set: { lastSeenAt: now, lastSeenHits: hits } },
    );
  }

  if (action === "new_alert" || action === "key_changed") {
    const admins = await __deps.getPlatformAdminEmails();
    if (admins.length === 0) {
      console.warn("[BackfillLoadAlerter] No platform admins configured; alert logged only");
    } else {
      const html = buildEmailHtml(hits, adminPanelUrl());
      const subject = buildSubject(hits);
      for (const email of admins) {
        try {
          await __deps.sendEmail({ to: email, subject, html });
          emailed++;
        } catch (err: any) {
          console.error(
            `[BackfillLoadAlerter] Email send failed for ${email}:`,
            err?.message || err,
          );
        }
      }
    }
    await alertsCol.updateOne(
      { _id: "global" as any },
      {
        $set: {
          alertKey: key,
          hits,
          lastAlertedAt: now,
          lastSeenAt: now,
          lastSeenHits: hits,
          ...(existing?.alertKey ? { previousAlertKey: existing.alertKey } : {}),
        },
        $setOnInsert: { firstAlertedAt: now },
      },
      { upsert: true },
    );
  }

  console.log(
    `[BackfillLoadAlerter] action=${action} key=${key || "(none)"} ` +
      `rlHits=${rlHits.length} eventLoopHit=${elHit ? 1 : 0} p95Hits=${p95Hits.length} ` +
      `recentChunks=${recentChunks.length} baselineChunks=${baselineChunks.length} ` +
      `hostSamples=${hostSamples.length} emailed=${emailed}`,
  );

  return NextResponse.json({
    ok: true,
    action,
    alertKey: key || null,
    emailed,
    hits,
    counts: {
      recentChunks: recentChunks.length,
      baselineChunks: baselineChunks.length,
      hostSamples: hostSamples.length,
    },
  });
}
