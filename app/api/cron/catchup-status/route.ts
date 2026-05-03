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
 * Schema notes (matches `app/api/cron/tekmetric-backfill/route.ts`):
 *   - Eligible shops: `shops` docs with either `tekmetric.shopId` or the
 *     legacy `tekmetricShopId` set.
 *   - Per-shop backfill state lives in `tekmetric_backfill_progress`
 *     (collection), NOT embedded in the shop doc.
 *   - Catch-up run summaries live in `tekmetric_catchup_runs` and are
 *     written by `scripts/tekmetric-catchup.mjs`.
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

    const [tekShops, progressRows, runs] = await Promise.all([
      db
        .collection("shops")
        .find({
          $or: [
            { "tekmetric.shopId": { $exists: true, $ne: null } },
            { tekmetricShopId: { $exists: true, $ne: null } },
          ],
        })
        .project({
          shopId: 1,
          name: 1,
          locationIdentifier: 1,
          "tekmetric.shopId": 1,
          tekmetricShopId: 1,
          tekmetricBackfillComplete: 1,
        })
        .toArray(),
      db.collection("tekmetric_backfill_progress").find({}).toArray(),
      db
        .collection("tekmetric_catchup_runs")
        .find({})
        .sort({ startedAt: -1 })
        .limit(runLimit)
        .toArray(),
    ]);

    const progressByShop = new Map<number, any>();
    for (const p of progressRows) {
      progressByShop.set(Number(p.shopId), p);
    }

    // shopId -> coverage info from the recent catch-up runs window
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
      const progress = progressByShop.get(Number(s.shopId)) || {};
      const cov = coverageMap.get(Number(s.shopId));
      const complete =
        s.tekmetricBackfillComplete === true || progress.completed === true || progress.complete === true;
      return {
        shopId: s.shopId,
        name: s.name || s.locationIdentifier || `Shop ${s.shopId}`,
        tekmetricShopId: s.tekmetric?.shopId ?? s.tekmetricShopId ?? null,
        complete,
        lastRunAt: progress.lastRunAt || null,
        lastCursorMoveAt: progress.lastCursorMoveAt || null,
        currentChunkEnd: progress.currentChunkEnd || null,
        lastError: progress.lastError || null,
        lastErrorAt: progress.lastErrorAt || null,
        lastCoveredByCatchupAt: cov?.lastSeenAt || null,
        catchupRunsCovered: cov?.runsCovered || 0,
        lastCatchupOutcome: cov?.lastOutcome || null,
      };
    });

    const incompleteShops = shopRows.filter((r) => !r.complete);
    const uncoveredShops = incompleteShops.filter(
      (r) => r.catchupRunsCovered === 0,
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
        tekShopsIncomplete: incompleteShops.length,
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
