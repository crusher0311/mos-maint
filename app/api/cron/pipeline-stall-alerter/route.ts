import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";
import { getPlatformAdminEmails } from "@/lib/super-admins";
import { sendOpsAlert } from "@/lib/alerts/notify";
import { getAllQueueSnapshots } from "@/lib/queue/metrics";
import { isQueueEnabled } from "@/lib/queue/connection";
import {
  PROVIDERS,
  DEFAULT_STALL_WINDOW_MS,
  DEFAULT_DRAIN_WEDGE_MS,
  DEFAULT_QUEUE_FAILED_THRESHOLD,
  computeProgressSignature,
  decidePipelineStall,
  decideDrainWedge,
  summarizeQueue,
  buildAlertKey,
  type StallHit,
} from "./lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whole-pipeline backfill stall alerter — task #568.
//
// The per-shop alerters (tekmetric-backfill-health, backfill-chunk-speed-health)
// page when ONE shop trips a threshold. cron-health-alerter pages when a cron
// stops returning 200. Neither catches the failure that slipped past for ~2
// days: the backfill cron keeps returning 200 (green) but makes ZERO real data
// progress across the WHOLE fleet — a wedged global drain lease or a loop that
// no-ops every tick. This cron is the fleet-level safety net.
//
// It does three things, then escalates beyond email (Slack + Better Stack via
// lib/alerts/notify) with state-based dedup:
//   1. Fleet heartbeat per provider — flag zero forward progress for a tunable
//      window while incomplete shops exist AND the loop is alive.
//   2. Drain-lease wedge — flag a global Tekmetric drain lease held too long.
//   3. Queue backlog — once REDIS_URL is set, include failed/stalled counts.
//
// Auth: standard `Authorization: Bearer ${CRON_SECRET}` like the other crons.

const HEARTBEAT_COLLECTION = "pipeline_progress_heartbeat";
const ALERTS_COLLECTION = "pipeline_stall_alerts";
const DRAIN_LOCK_COLLECTION = "tekmetric_drain_lock";

// Test seam — the route smoke test swaps these for in-memory fakes.
export const __deps = {
  getDb,
  sendEmail,
  getPlatformAdminEmails,
  sendOpsAlert,
  getAllQueueSnapshots,
  isQueueEnabled,
};

function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function fmtMins(ms: number | null): string {
  if (ms == null) return "n/a";
  return `${Math.round(ms / 60000)} min`;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const windowMs = envMs("PIPELINE_STALL_WINDOW_MS", DEFAULT_STALL_WINDOW_MS);
  const drainWedgeMs = envMs("PIPELINE_DRAIN_WEDGE_MS", DEFAULT_DRAIN_WEDGE_MS);
  const queueFailedThreshold = envMs(
    "PIPELINE_QUEUE_FAILED_THRESHOLD",
    DEFAULT_QUEUE_FAILED_THRESHOLD,
  );

  const now = new Date();
  const nowMs = now.getTime();

  // App-data DB holds per-shop progress, the drain lock, and our own
  // heartbeat/alert state. The cron bookkeeping lives in the separate `mos`
  // DB (lastSuccessByJob), so we read that too for the liveness gate.
  const db = await __deps.getDb();
  const cronDb = await __deps.getDb("mos");

  const statusDoc = await cronDb
    .collection("cron_status")
    .findOne({ _id: "global" as any });
  const lastSuccessMap = ((statusDoc as any)?.lastSuccessByJob || {}) as Record<
    string,
    Date | string
  >;
  function providerLastSuccessMs(jobNames: string[]): number | null {
    let max: number | null = null;
    for (const name of jobNames) {
      const ts = lastSuccessMap[name];
      if (!ts) continue;
      const t = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
      if (!Number.isFinite(t)) continue;
      if (max == null || t > max) max = t;
    }
    return max;
  }

  const hits: StallHit[] = [];
  const providerReport: any[] = [];

  // (1) Fleet progress heartbeat, per provider ---------------------------
  for (const provider of PROVIDERS) {
    const rows = await db
      .collection(provider.collectionName)
      .find({})
      .toArray();
    const sig = computeProgressSignature(rows as any[]);

    const hb = await db
      .collection(HEARTBEAT_COLLECTION)
      .findOne({ _id: provider.key as any });
    const prevSig = (hb as any)?.lastSignature ?? null;
    let lastChangedAt =
      (hb as any)?.lastChangedAt != null
        ? new Date((hb as any).lastChangedAt)
        : null;
    const changed = prevSig == null || prevSig !== sig.signature;
    if (changed || lastChangedAt == null || isNaN(lastChangedAt.getTime())) {
      lastChangedAt = now;
    }
    await db.collection(HEARTBEAT_COLLECTION).updateOne(
      { _id: provider.key as any },
      {
        $set: {
          lastSignature: sig.signature,
          lastChangedAt,
          lastSeenAt: now,
          incompleteShops: sig.incompleteShops,
          completedShops: sig.completedShops,
        },
      },
      { upsert: true },
    );

    const stalledMs = nowMs - lastChangedAt.getTime();
    const lastBackfillSuccessMs = providerLastSuccessMs(provider.backfillJobNames);
    const decision = decidePipelineStall({
      incompleteShops: sig.incompleteShops,
      stalledMs,
      windowMs,
      lastBackfillSuccessMs,
      nowMs,
      livenessWindowMs: windowMs,
    });

    providerReport.push({
      provider: provider.key,
      incompleteShops: sig.incompleteShops,
      completedShops: sig.completedShops,
      stalledMs,
      stalled: decision.stalled,
      deferredToCronHealth: decision.deferredToCronHealth ?? false,
      lastBackfillSuccessAgoMs:
        lastBackfillSuccessMs != null ? nowMs - lastBackfillSuccessMs : null,
    });

    if (decision.stalled) {
      hits.push({
        reason: "no_progress",
        provider: provider.key,
        providerLabel: provider.label,
        stalledMs,
        incompleteShops: sig.incompleteShops,
        lastBackfillSuccessMs,
      });
    }
  }

  // (2) Drain-lease wedge (Tekmetric) ------------------------------------
  const lock = await db
    .collection(DRAIN_LOCK_COLLECTION)
    .findOne({ _id: "global" as any });
  const wedge = decideDrainWedge(lock, nowMs, drainWedgeMs);
  if (wedge) {
    hits.push({
      reason: "drain_wedge",
      provider: "tekmetric",
      providerLabel: "Tekmetric",
      wedge,
    });
  }

  // (3) Queue backlog (only once REDIS_URL is set) -----------------------
  const queueEnabled = __deps.isQueueEnabled();
  let queueSnapshots: Array<{ name: string; counts: any }> | null = null;
  if (queueEnabled) {
    try {
      queueSnapshots = await __deps.getAllQueueSnapshots();
    } catch (err: any) {
      console.error(
        "[PipelineStallAlerter] queue snapshot failed:",
        err?.message,
      );
    }
  }
  const queue = summarizeQueue(queueSnapshots, queueFailedThreshold, queueEnabled);
  if (queue.breaches.length > 0) {
    hits.push({
      reason: "queue_backlog",
      queues: queue.breaches,
      totalFailed: queue.totalFailed,
      totalStalled: queue.totalStalled,
    });
  }

  const alertKey = buildAlertKey(hits);

  // State-based dedup: singleton alert doc. Re-page only when the breach set
  // (alertKey) changes; auto-clear when everything recovers.
  const existing = await db
    .collection(ALERTS_COLLECTION)
    .findOne({ _id: "global" as any });

  let action: "none" | "alerted" | "cleared" | "deduped" = "none";

  if (hits.length === 0) {
    if (existing) {
      await db
        .collection(ALERTS_COLLECTION)
        .deleteOne({ _id: "global" as any });
      action = "cleared";
    }
    return NextResponse.json({
      ok: true,
      action,
      windowMinutes: Math.round(windowMs / 60000),
      providers: providerReport,
      queue,
      drainWedge: null,
    });
  }

  const changed = !existing || (existing as any).alertKey !== alertKey;
  if (changed) {
    action = "alerted";
    await db.collection(ALERTS_COLLECTION).updateOne(
      { _id: "global" as any },
      {
        $set: {
          alertKey,
          lastAlertedAt: now,
          lastSeenAt: now,
          hits,
        },
        $setOnInsert: { firstAlertedAt: now },
      },
      { upsert: true },
    );
    await escalate(hits, queue, windowMs, alertKey);
  } else {
    action = "deduped";
    await db
      .collection(ALERTS_COLLECTION)
      .updateOne({ _id: "global" as any }, { $set: { lastSeenAt: now, hits } });
  }

  return NextResponse.json({
    ok: true,
    action,
    alertKey,
    windowMinutes: Math.round(windowMs / 60000),
    providers: providerReport,
    queue,
    drainWedge: wedge,
  });
}

async function escalate(
  hits: StallHit[],
  queue: ReturnType<typeof summarizeQueue>,
  windowMs: number,
  alertKey: string,
) {
  const lines: string[] = [];
  const fields: Record<string, string | number> = {};
  let severity: "critical" | "warning" = "warning";

  for (const h of hits) {
    if (h.reason === "no_progress") {
      severity = "critical";
      lines.push(
        `${h.providerLabel}: no fleet progress for ${fmtMins(h.stalledMs)} ` +
          `(${h.incompleteShops} incomplete shops, backfill cron last succeeded ` +
          `${fmtMins(h.lastBackfillSuccessMs != null ? Date.now() - h.lastBackfillSuccessMs : null)} ago — running but stuck).`,
      );
    } else if (h.reason === "drain_wedge") {
      severity = "critical";
      lines.push(
        `Tekmetric drain lease held ${fmtMins(h.wedge.heldMs)} by ` +
          `${h.wedge.owner} (${h.wedge.live ? "still live" : "just expired"}); ` +
          `the backfill cron is paused while this lease is held.`,
      );
      fields["drain.owner"] = h.wedge.owner;
      fields["drain.heldMin"] = Math.round(h.wedge.heldMs / 60000);
      if (h.wedge.expiresAt) fields["drain.expiresAt"] = h.wedge.expiresAt;
      if (h.wedge.lastRefreshAt) fields["drain.lastRefreshAt"] = h.wedge.lastRefreshAt;
    } else if (h.reason === "queue_backlog") {
      lines.push(
        `Queue backlog: ${h.totalFailed} failed, ${h.totalStalled} stalled ` +
          `across ${h.queues.join(", ")}.`,
      );
      fields["queue.failed"] = h.totalFailed;
      fields["queue.stalled"] = h.totalStalled;
    }
  }

  if (queue.enabled) {
    fields["queue.totalFailed"] = queue.totalFailed;
    fields["queue.totalStalled"] = queue.totalStalled;
  }

  // Channel 1 + 2: Slack (optional) + Better Stack structured line.
  try {
    await __deps.sendOpsAlert({
      title: "Backfill pipeline stalled",
      severity,
      summary: `Whole-pipeline backfill safety net tripped (window ${Math.round(windowMs / 60000)} min).`,
      fields,
      lines,
      source: "pipeline-stall-alerter",
      dedupKey: alertKey,
    });
  } catch (err: any) {
    console.error("[PipelineStallAlerter] sendOpsAlert failed:", err?.message);
  }

  // Channel 3: email platform admins (kept — extends, doesn't replace).
  try {
    const admins = await __deps.getPlatformAdminEmails();
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:720px">
        <h2 style="color:#b91c1c;margin:0 0 8px">Backfill pipeline stalled</h2>
        <p style="color:#444;margin:0 0 16px">
          The whole-pipeline safety net detected the fleet-wide backfill making
          no progress (or a wedged drain lease). This is distinct from per-shop
          staleness — the cron may be green while accomplishing nothing.
        </p>
        <ul style="color:#222;font-size:14px;line-height:1.6">
          ${lines.map((l) => `<li>${l}</li>`).join("")}
        </ul>
        <p style="margin-top:16px;color:#666;font-size:13px">
          Sent by <code>/api/cron/pipeline-stall-alerter</code>. Also escalated to
          Slack/Better Stack. Deduped on the breach set — you'll be re-paged only
          when it changes or recovers and breaks again.
        </p>
      </div>`;
    for (const email of admins) {
      try {
        await __deps.sendEmail({
          to: email,
          subject: `[MOS] Backfill pipeline stalled (${alertKey})`,
          html,
        });
      } catch (err: any) {
        console.error(
          `[PipelineStallAlerter] Email send failed for ${email}:`,
          err?.message,
        );
      }
    }
  } catch (err: any) {
    console.error("[PipelineStallAlerter] admin email lookup failed:", err?.message);
  }
}
