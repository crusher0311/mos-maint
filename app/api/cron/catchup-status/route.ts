import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only status endpoint for Tekmetric backfill catch-up coverage.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` (same as the other
 * crons under /api/cron/). Intentionally NOT gated on a platform-admin
 * session so it can be polled from a shell / CI / dev sandbox that can't
 * authenticate through the normal browser flow.
 *
 * Returns a single JSON snapshot suitable for answering "is catch-up
 * actually running on every shop?":
 *   - tekShops: every Tekmetric-enabled shop with backfill state + a
 *     `lastCoveredByCatchupAt` timestamp (when this shopId last appeared
 *     in a `tekmetric_catchup_runs.results[]` row).
 *   - catchupRuns: most-recent N catch-up run summaries.
 *   - uncoveredShops: tek shops never seen in the last N catch-up runs.
 *   - summary: counts for quick glance.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const runLimit = Math.max(
    1,
    Math.min(100, Number(url.searchParams.get("runs") || 20)),
  );
  const coverageWindowRuns = Math.max(
    1,
    Math.min(runLimit, Number(url.searchParams.get("coverage") || 10)),
  );

  try {
    const db = await getDb();

    const [tekShops, runs] = await Promise.all([
      db
        .collection("shops")
        .find({ "integrations.tekmetric.enabled": true })
        .project({
          shopId: 1,
          name: 1,
          "integrations.tekmetric.shopId": 1,
          "integrations.tekmetric.lastSyncAt": 1,
          "integrations.tekmetric.backfillState": 1,
          "integrations.tekmetric.backfillProgress": 1,
        })
        .toArray(),
      db
        .collection("tekmetric_catchup_runs")
        .find({})
        .sort({ startedAt: -1 })
        .limit(runLimit)
        .toArray(),
    ]);

    // Build a shopId -> { lastSeenAt, runsCovered } map from the catch-up
    // runs window. The script writes one entry per shop into
    // results[]; each entry carries shopId + outcome.
    const coverageMap = new Map<
      number,
      { lastSeenAt: Date | null; runsCovered: number; lastOutcome: string | null }
    >();
    const coverageWindow = runs.slice(0, coverageWindowRuns);
    for (const run of coverageWindow) {
      const ts: Date | null = run.startedAt || run.createdAt || null;
      const results: any[] = Array.isArray(run.results) ? run.results : [];
      for (const r of results) {
        const sid = Number(r.shopId);
        if (!Number.isFinite(sid)) continue;
        const existing = coverageMap.get(sid);
        if (existing) {
          existing.runsCovered += 1;
          if (ts && (!existing.lastSeenAt || ts > existing.lastSeenAt)) {
            existing.lastSeenAt = ts;
            existing.lastOutcome = r.outcome ?? existing.lastOutcome;
          }
        } else {
          coverageMap.set(sid, {
            lastSeenAt: ts,
            runsCovered: 1,
            lastOutcome: r.outcome ?? null,
          });
        }
      }
    }

    const shopRows = tekShops.map((s: any) => {
      const tek = s.integrations?.tekmetric || {};
      const bf = tek.backfillState || {};
      const bp = tek.backfillProgress || {};
      const cov = coverageMap.get(Number(s.shopId));
      return {
        shopId: s.shopId,
        name: s.name || `Shop ${s.shopId}`,
        tekmetricShopId: tek.shopId ?? null,
        complete: bf.complete === true || bp.complete === true,
        lastRunAt: bf.lastRunAt || bp.lastRunAt || null,
        lastCursorMoveAt: bf.lastCursorMoveAt || bp.lastCursorMoveAt || null,
        currentChunkEnd: bf.currentChunkEnd || bp.currentChunkEnd || null,
        lastError: bf.lastError || bp.lastError || null,
        lastErrorAt: bf.lastErrorAt || bp.lastErrorAt || null,
        lastCoveredByCatchupAt: cov?.lastSeenAt || null,
        catchupRunsCovered: cov?.runsCovered || 0,
        lastCatchupOutcome: cov?.lastOutcome || null,
      };
    });

    const uncoveredShops = shopRows.filter(
      (r) => !r.complete && r.catchupRunsCovered === 0,
    );

    const trimmedRuns = runs.map((r: any) => ({
      _id: r._id?.toString(),
      startedAt: r.startedAt || null,
      finishedAt: r.finishedAt || null,
      durationMs: r.durationMs ?? null,
      shopCount: Array.isArray(r.results) ? r.results.length : (r.shopCount ?? null),
      completedCount: r.completedCount ?? null,
      recoveredCount: r.recoveredCount ?? null,
      needsFollowupCount: r.needsFollowupCount ?? null,
      dryRunCount: r.dryRunCount ?? null,
      filtersApplied: r.filtersApplied ?? null,
      suggestedRerun: r.suggestedRerun ?? null,
      trigger: r.trigger ?? r.invokedBy ?? null,
    }));

    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: {
        tekShopsTotal: shopRows.length,
        tekShopsComplete: shopRows.filter((r) => r.complete).length,
        tekShopsIncomplete: shopRows.filter((r) => !r.complete).length,
        tekShopsWithLastError: shopRows.filter((r) => !!r.lastError).length,
        catchupRunsReturned: trimmedRuns.length,
        coverageWindowRuns: coverageWindow.length,
        uncoveredShopCount: uncoveredShops.length,
      },
      catchupRuns: trimmedRuns,
      shops: shopRows,
      uncoveredShops,
    });
  } catch (err: any) {
    console.error("[catchup-status] error:", err);
    return NextResponse.json(
      { error: err?.message || "Unknown error" },
      { status: 500 },
    );
  }
}
