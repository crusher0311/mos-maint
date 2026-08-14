import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";
import { PROVIDERS } from "@/app/api/cron/pipeline-stall-alerter/lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Triage summary (task #1119) — one-load consolidated first read for
 * bug/slowness reports, so on-call doesn't have to click through every
 * per-provider tab:
 *
 *   - fleet last-REAL-progress per provider (from the pipeline-stall
 *     alerter's `pipeline_progress_heartbeat` — its `lastChangedAt` only
 *     moves on real forward progress, never on no-op ticks)
 *   - cron loop liveness (per-provider max of backfill job successes from
 *     the `mos` DB `cron_status.lastSuccessByJob` — cron bookkeeping lives
 *     in a SEPARATE Mongo database from app data)
 *   - queue depth per lane (BullMQ snapshots; cleanly absent when Redis is
 *     not configured)
 *   - webhook received-vs-processed deltas (Protractor has processedAt;
 *     Tekmetric/AutoFlow are received-only feeds)
 *   - production_logs feed freshness (max dt — a frozen feed can look green
 *     while blind; see log-sync blackout incident)
 *   - most recent alert states from the alert-state collections (the
 *     durable trace of what [OPS-ALERT] paged on; the stderr line itself
 *     is not persisted)
 *
 * Everything here is read-only.
 */
export async function GET() {
  try {
    await requirePlatformAdmin();

    const db = await getDb();
    const cronDb = await getDb("mos");
    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60 * 1000);

    // --- fleet last-real-progress per provider (heartbeat singletons) ----
    const heartbeatsP = db
      .collection("pipeline_progress_heartbeat")
      .find({})
      .toArray()
      .catch(() => [] as any[]);

    // --- cron liveness ----------------------------------------------------
    const cronStatusP = cronDb
      .collection("cron_status")
      .findOne({ _id: "global" as any })
      .catch(() => null);

    // --- queue depths -----------------------------------------------------
    const queueP = (async () => {
      try {
        const { isQueueEnabled } = await import("@/lib/queue/connection");
        if (!isQueueEnabled()) return { enabled: false, queues: [] as any[] };
        const { getAllQueueSnapshots } = await import("@/lib/queue/metrics");
        const snaps = await getAllQueueSnapshots();
        return {
          enabled: true,
          queues: snaps.map((s: any) => ({
            name: s.name,
            waiting: s.counts?.waiting ?? 0,
            active: s.counts?.active ?? 0,
            failed: s.counts?.failed ?? 0,
            delayed: s.counts?.delayed ?? 0,
            error: s.error ?? null,
          })),
        };
      } catch (err: any) {
        return { enabled: false, queues: [], error: String(err?.message || err) };
      }
    })();

    // --- webhook deltas (last 24h) -----------------------------------------
    const webhooksP = (async () => {
      const [tekReceived, tekLast, proReceived, proProcessed, proBacklog, afReceived] =
        await Promise.all([
          db.collection("tekmetric_webhook_logs")
            .countDocuments({ receivedAt: { $gte: since24h } }).catch(() => null),
          db.collection("tekmetric_webhook_logs")
            .find({}).sort({ receivedAt: -1 }).limit(1).toArray()
            .then((r) => (r[0] as any)?.receivedAt ?? null).catch(() => null),
          db.collection("protractor_callback_events")
            .countDocuments({ receivedAt: { $gte: since24h } }).catch(() => null),
          db.collection("protractor_callback_events")
            .countDocuments({ receivedAt: { $gte: since24h }, processed: true })
            .catch(() => null),
          // Unprocessed events older than 15 min = the silent-wedge pattern
          // (webhooks arrive while processing wedges with attempts=0).
          db.collection("protractor_callback_events")
            .countDocuments({
              processed: { $ne: true },
              receivedAt: { $lt: new Date(now - 15 * 60 * 1000) },
            }).catch(() => null),
          db.collection("events")
            .countDocuments({ provider: "autoflow", receivedAt: { $gte: since24h } })
            .catch(() => null),
        ]);
      return {
        tekmetric: { received24h: tekReceived, lastReceivedAt: tekLast, processedTracking: false },
        protractor: {
          received24h: proReceived,
          processed24h: proProcessed,
          delta24h: proReceived != null && proProcessed != null ? proReceived - proProcessed : null,
          unprocessedOlderThan15m: proBacklog,
          processedTracking: true,
        },
        autoflow: { received24h: afReceived, processedTracking: false },
      };
    })();

    // --- production_logs feed freshness ------------------------------------
    const logFeedP = (async () => {
      try {
        const { getDb: getPg } = await import("@/lib/db/drizzle");
        const { productionLogs } = await import("@/lib/db/schema/logs");
        const { sql } = await import("drizzle-orm");
        const rows: any[] = await getPg()
          .select({ maxDt: sql<string>`max(${productionLogs.dt})` })
          .from(productionLogs);
        const maxDt = rows?.[0]?.maxDt ?? null;
        const ageMs = maxDt ? now - new Date(maxDt).getTime() : null;
        return { maxDt, ageMs, stale: ageMs != null ? ageMs > 60 * 60 * 1000 : null };
      } catch (err: any) {
        return { maxDt: null, ageMs: null, stale: null, error: String(err?.message || err) };
      }
    })();

    // --- recent alert states (what [OPS-ALERT] has paged on) ----------------
    const alertsP = (async () => {
      const sources: Array<{ collection: string; label: string }> = [
        { collection: "pipeline_stall_alerts", label: "Pipeline stall" },
        { collection: "backfill_chunk_speed_alerts", label: "Chunk speed" },
        { collection: "tekmetric_backfill_health_alerts", label: "Tekmetric backfill health" },
        { collection: "tekmetric_webhook_health_alerts", label: "Tekmetric webhook health" },
        { collection: "tekmetric_permfailed_ro_alerts", label: "Perm-failed ROs" },
        { collection: "protractor_webhook_health_alerts", label: "Protractor webhook health" },
      ];
      const out: any[] = [];
      for (const s of sources) {
        try {
          const rows = await db.collection(s.collection)
            .find({}).sort({ lastAlertedAt: -1 }).limit(3).toArray();
          for (const r of rows as any[]) {
            out.push({
              source: s.label,
              collection: s.collection,
              shopId: r.shopId ?? null,
              alertKey: r.alertKey ?? null,
              reasons: r.reasons ?? r.hits ?? null,
              firstAlertedAt: r.firstAlertedAt ?? null,
              lastAlertedAt: r.lastAlertedAt ?? null,
            });
          }
        } catch { /* collection may not exist — skip */ }
      }
      out.sort((a, b) =>
        new Date(b.lastAlertedAt ?? 0).getTime() - new Date(a.lastAlertedAt ?? 0).getTime());
      return out.slice(0, 10);
    })();

    const [heartbeats, cronStatus, queue, webhooks, logFeed, recentAlerts] =
      await Promise.all([heartbeatsP, cronStatusP, queueP, webhooksP, logFeedP, alertsP]);

    const lastSuccessByJob = ((cronStatus as any)?.lastSuccessByJob || {}) as Record<string, any>;
    const hbByKey = new Map((heartbeats as any[]).map((h) => [String(h._id), h]));

    const providers = PROVIDERS.map((p) => {
      const hb: any = hbByKey.get(p.key) ?? null;
      let lastCronSuccess: number | null = null;
      for (const name of p.backfillJobNames) {
        const ts = lastSuccessByJob[name];
        if (!ts) continue;
        const t = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
        if (Number.isFinite(t) && (lastCronSuccess == null || t > lastCronSuccess)) lastCronSuccess = t;
      }
      return {
        provider: p.key,
        label: p.label,
        lastRealProgressAt: hb?.lastChangedAt ?? null,
        heartbeatSeenAt: hb?.lastSeenAt ?? null,
        incompleteShops: hb?.incompleteShops ?? null,
        completedShops: hb?.completedShops ?? null,
        lastCronSuccessAt: lastCronSuccess != null ? new Date(lastCronSuccess).toISOString() : null,
        cronAlive: lastCronSuccess != null ? now - lastCronSuccess < 3 * 60 * 60 * 1000 : false,
      };
    });

    return NextResponse.json({
      generatedAt: new Date(now).toISOString(),
      providers,
      queue,
      webhooks,
      logFeed,
      recentAlerts,
    });
  } catch (error: any) {
    // requirePlatformAdmin() denies via redirect() — rethrow so Next.js
    // performs the redirect instead of surfacing a 500 JSON.
    if (error?.digest?.startsWith?.("NEXT_REDIRECT")) throw error;
    console.error("[Admin Triage] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
