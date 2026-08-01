import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  listProgress as listTekmetricProgress,
  listCatchupRuns as listTekmetricCatchupRuns,
} from "@/lib/data/repositories/tekmetric-ops";
import {
  buildChunkSpeed,
  computeStuckDiagnostics,
  loadChunkSpeedAlertsByKey,
  safeIso,
  SLOW_P95_THRESHOLD_MS,
} from "../_shared";

// Tekmetric slice of the sync-health payload. Originally this lived on the
// monolithic `/api/admin/sync-health` route alongside Protractor + Shop-Ware
// + overview stats, which on prod blew past the platform's request budget
// and rendered the page as skeleton-forever (task #288). The page now fetches
// each provider in parallel from a dedicated sub-route — same data shape,
// just split so each request fits in the budget and sections render
// independently.
export async function GET() {
  try {
    await requirePlatformAdmin();

    const db = await getDb();
    const staleArchiveSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [
      tekmetricBackfillProgress,
      tekmetricStaleArchivedAgg,
      tekmetricShopDocs,
      chunkSpeedAlertsByKey,
      tekmetricCatchupRunDocs,
      tekmetricEligibleShopDocs,
    ] = await Promise.all([
      listTekmetricProgress(),
      // Aggregate stale-archived entries (auto-archived after 30d without
      // re-fetch). Surfaces in the admin view as a separate "stale, never
      // re-fetched" bucket so cold leftovers stop polluting the live skipped
      // list. Limited to the last 14 days so the bucket stays focused on
      // recent sweep activity rather than historical buildup.
      db.collection("tekmetric_skipped_ro_archive").aggregate([
        { $match: { stale: true, archivedAt: { $gte: staleArchiveSince } } },
        {
          $group: {
            _id: "$shopId",
            entriesArchived: { $sum: 1 },
            lastArchivedAt: { $max: "$archivedAt" },
            oldestSkippedAt: { $min: "$skippedAt" },
            permanentlyFailedCount: {
              $sum: { $cond: [{ $eq: ["$permanentlyFailed", true] }, 1, 0] },
            },
          },
        },
        { $sort: { lastArchivedAt: -1 } },
        { $limit: 100 },
      ]).toArray(),
      // Pull just the fields we need for the jobs-cache-prewarm overlay.
      // Restricted to shops with a Tekmetric integration so the join
      // isn't paying for shops that will never have a prewarm record.
      db.collection("shops").find(
        { "tekmetric.shopId": { $exists: true, $ne: null } },
        {
          projection: {
            shopId: 1,
            "tekmetric.shopId": 1,
            "tekmetric.jobsCachePrewarm": 1,
            // Inspections-endpoint x-auth-token health (task #279). Stamped
            // by lib/integrations/tekmetric/client.ts when a shop trips the
            // 401 short-circuit on the internal inspections endpoint, and
            // cleared on the next successful 200. Surfaced here so admins
            // can see "shop X's inspections token is broken — N ROs skipped
            // this cycle" without trawling the API traffic page.
            "tekmetric.inspectionsTokenHealth": 1,
            _id: 0,
          },
        },
      ).toArray(),
      loadChunkSpeedAlertsByKey(db),
      // Tekmetric catch-up run summaries persisted by
      // `scripts/tekmetric-catchup.mjs` (task #181). The script writes one
      // doc per run with the SUMMARY block contents + filters used + a
      // suggested re-run command. Surfaced here so on-call can pull up the
      // last few catch-ups from the UI without grepping a multi-hour log.
      // Pull the most-recent 10 runs: the first 5 feed the visible
      // "Tekmetric catch-up runs" section below; all 10 form the
      // coverage window that powers the catch-up-coverage card so
      // on-call can see which Tekmetric shops haven't been touched by
      // the recent overnight runs (task #287). Mirrors the
      // `coverage` default in /api/cron/catchup-status.
      listTekmetricCatchupRuns(10),
      // Tekmetric-eligible shops for the catch-up coverage join (task
      // #287). Same OR-filter as /api/cron/catchup-status so the totals
      // on the sync-health card line up with what that endpoint returns.
      // Kept separate from `tekmetricShopDocs` (which intentionally
      // restricts to `tekmetric.shopId` for the inspections / prewarm
      // overlays) because legacy `tekmetricShopId` shops should still
      // count toward coverage.
      db.collection("shops")
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
          _id: 0,
        })
        .toArray(),
    ]);

    // Serialize catch-up run summaries for the JSON response. Date fields
    // are normalized to ISO strings so the renderer doesn't have to parse
    // BSON Date objects, and missing/legacy fields are defaulted to safe
    // empty values so an old record from before the script change can still
    // be displayed without crashing the view.
    const tekmetricCatchupRuns = (tekmetricCatchupRunDocs as any[]).slice(0, 5).map((d) => {
      const startedAt = d?.startedAt ? safeIso(d.startedAt) : null;
      const finishedAt = d?.finishedAt ? safeIso(d.finishedAt) : null;
      return {
        startedAt,
        finishedAt,
        durationMs: typeof d?.durationMs === "number" ? d.durationMs : null,
        dryRun: !!d?.dryRun,
        prodBaseUrl: d?.prodBaseUrl || null,
        filters: {
          onlyShops: Array.isArray(d?.filters?.onlyShops) ? d.filters.onlyShops : [],
          skipShops: Array.isArray(d?.filters?.skipShops) ? d.filters.skipShops : [],
        },
        totals: {
          processed: Number(d?.totals?.processed || 0),
          completed: Number(d?.totals?.completed || 0),
          recovered: Number(d?.totals?.recovered || 0),
          needsFollowup: Number(d?.totals?.needsFollowup || 0),
          dryRun: Number(d?.totals?.dryRun || 0),
        },
        completedShopIds: Array.isArray(d?.completedShopIds) ? d.completedShopIds : [],
        recoveredShopIds: Array.isArray(d?.recoveredShopIds) ? d.recoveredShopIds : [],
        dryRunShopIds: Array.isArray(d?.dryRunShopIds) ? d.dryRunShopIds : [],
        needsFollowup: Array.isArray(d?.needsFollowup)
          ? d.needsFollowup.map((n: any) => ({
              shopId: Number(n?.shopId),
              reason: n?.reason || null,
            }))
          : [],
        suggestedRerunCommand: d?.suggestedRerunCommand || null,
      };
    });

    // Catch-up coverage (task #287). Mirrors the per-shop join performed by
    // /api/cron/catchup-status: walk the most-recent N catch-up runs and
    // tally, for each Tekmetric-eligible shop, how many of those runs
    // included it and when it was last touched. The cron-style endpoint is
    // gated on CRON_SECRET, so on-call needs the same data exposed in the
    // browser-facing platform-admin Sync Health page. Window matches the
    // endpoint's default of 10 runs.
    const COVERAGE_WINDOW_RUNS = 10;
    const tekmetricBackfillCompleteByShop = new Map<number, boolean>();
    // Per-shop lastRunAt is needed for the catch-up coverage row's
    // "hours since last run" column (task #468). Pull it from the same
    // progress docs we already loaded so we don't fan out an extra
    // Mongo query just to render the cadence column.
    const tekmetricLastRunAtByShop = new Map<number, Date | null>();
    for (const p of tekmetricBackfillProgress as any[]) {
      const sid = Number(p.shopId);
      tekmetricBackfillCompleteByShop.set(sid, !!p.completed);
      tekmetricLastRunAtByShop.set(
        sid,
        p?.lastRunAt ? new Date(p.lastRunAt) : null,
      );
    }
    const nowMsForCoverage = Date.now();
    const catchupCoverageMap = new Map<
      number,
      { lastSeenAt: Date | null; runsCovered: number; lastOutcome: string | null }
    >();
    const catchupCoverageWindow = (tekmetricCatchupRunDocs as any[]).slice(
      0,
      COVERAGE_WINDOW_RUNS,
    );
    for (const run of catchupCoverageWindow) {
      const ts: Date | null = run?.startedAt || run?.createdAt || null;
      const results: any[] = Array.isArray(run?.results) ? run.results : [];
      // Older catch-up runs (pre-task-#181 schema change) don't have a
      // per-shop `results` array — they only persisted bucketed shop ID
      // lists. Fall back to those buckets so coverage history doesn't
      // drop to zero just because the renderer is looking back further
      // than the new schema's existed.
      const fallbackIds: number[] = results.length === 0
        ? Array.from(
            new Set([
              ...((Array.isArray(run?.completedShopIds) ? run.completedShopIds : []) as number[]),
              ...((Array.isArray(run?.recoveredShopIds) ? run.recoveredShopIds : []) as number[]),
              ...((Array.isArray(run?.dryRunShopIds) ? run.dryRunShopIds : []) as number[]),
              ...((Array.isArray(run?.needsFollowup)
                ? run.needsFollowup.map((n: any) => Number(n?.shopId))
                : []) as number[]),
            ]),
          ).filter((n) => Number.isFinite(n))
        : [];
      const iter: { sid: number; outcome: string | null }[] = results.length > 0
        ? results.map((r: any) => ({
            sid: Number(r?.shopId),
            outcome: r?.outcome ?? null,
          }))
        : fallbackIds.map((sid) => ({ sid, outcome: null }));
      for (const { sid, outcome } of iter) {
        if (!Number.isFinite(sid)) continue;
        const existing = catchupCoverageMap.get(sid);
        if (existing) {
          existing.runsCovered += 1;
          if (ts && (!existing.lastSeenAt || ts > existing.lastSeenAt)) {
            existing.lastSeenAt = ts;
            existing.lastOutcome = outcome ?? existing.lastOutcome;
          }
        } else {
          catchupCoverageMap.set(sid, {
            lastSeenAt: ts,
            runsCovered: 1,
            lastOutcome: outcome ?? null,
          });
        }
      }
    }
    const tekmetricCatchupCoverageShops = (tekmetricEligibleShopDocs as any[])
      .map((s: any) => {
        const sid = Number(s.shopId);
        const cov = catchupCoverageMap.get(sid);
        const tekShopId = s?.tekmetric?.shopId ?? s?.tekmetricShopId ?? null;
        const complete =
          s.tekmetricBackfillComplete === true ||
          tekmetricBackfillCompleteByShop.get(sid) === true;
        const lastRunAt = tekmetricLastRunAtByShop.get(sid) || null;
        // `hoursSinceLastRun` is rounded to 1 decimal place — the column
        // is for at-a-glance cadence triage, not a precise SLA timer.
        const hoursSinceLastRun = lastRunAt
          ? Math.round(
              ((nowMsForCoverage - lastRunAt.getTime()) / (60 * 60 * 1000)) *
                10,
            ) / 10
          : null;
        return {
          shopId: sid,
          name: s.name || s.locationIdentifier || `Shop ${sid}`,
          tekmetricShopId: tekShopId,
          complete,
          lastCoveredByCatchupAt: cov?.lastSeenAt
            ? safeIso(cov.lastSeenAt)
            : null,
          catchupRunsCovered: cov?.runsCovered || 0,
          lastCatchupOutcome: cov?.lastOutcome || null,
          // Per-shop backfill cadence (task #468). `lastRunAt` is the
          // same field the cron uses for fair-queue ordering, so this
          // column mirrors what the chunker is actually doing.
          lastRunAt: lastRunAt ? safeIso(lastRunAt) : null,
          hoursSinceLastRun,
        };
      })
      // Worst-coverage first: shops never covered float to the top, then
      // shops covered the fewest times, then by shopId so the order is
      // stable across loads.
      .sort((a: any, b: any) => {
        if (a.catchupRunsCovered !== b.catchupRunsCovered) {
          return a.catchupRunsCovered - b.catchupRunsCovered;
        }
        return a.shopId - b.shopId;
      });
    const tekmetricCatchupCoverage = {
      coverageWindowRuns: catchupCoverageWindow.length,
      windowRunLimit: COVERAGE_WINDOW_RUNS,
      tekShopsTotal: tekmetricCatchupCoverageShops.length,
      // Match /api/cron/catchup-status semantics: "uncovered" only
      // counts incomplete shops, since completed shops legitimately
      // don't need catch-up runs anymore.
      uncoveredShopCount: tekmetricCatchupCoverageShops.filter(
        (s: any) => s.catchupRunsCovered === 0 && !s.complete,
      ).length,
      // Cadence summary (task #468). Counts incomplete shops whose
      // `lastRunAt` is either missing entirely or more than 24h old, so
      // the dashboard banner can flag a stalled weekday boost without
      // waiting for the stuck-shop alerter.
      incompleteShopsNotRunIn24hCount: tekmetricCatchupCoverageShops.filter(
        (s: any) =>
          !s.complete &&
          (s.hoursSinceLastRun === null || s.hoursSinceLastRun >= 24),
      ).length,
      incompleteShopsTotal: tekmetricCatchupCoverageShops.filter(
        (s: any) => !s.complete,
      ).length,
      shops: tekmetricCatchupCoverageShops,
    };

    const tekmetricShopsComplete = tekmetricBackfillProgress.filter((p: any) => p.completed).length;
    const tekmetricShopsTotal = tekmetricBackfillProgress.length;

    // Stuck-shop diagnostics. A shop is "stuck" if:
    //   - it has never run despite being in the queue (no lastRunAt), OR
    //   - it hasn't run in more than 48h, OR
    //   - its cursor hasn't moved in more than 3 days, OR
    //   - it has a current lastError.
    const tekmetricDiagnostics = computeStuckDiagnostics(tekmetricBackfillProgress);

    // Force-skipped windows are written by the Tekmetric backfill cron after 3
    // consecutive failures on the same chunk. They represent unrecovered data
    // gaps and persist on the progress row even after the shop completes, so
    // we surface them independently of the stuck-shop diagnostics (which only
    // consider in-flight rows).
    const tekmetricForceSkippedWindows = tekmetricBackfillProgress
      .filter((p: any) => p.lastForceSkippedWindow && p.lastForceSkippedWindow.start && p.lastForceSkippedWindow.end)
      .map((p: any) => {
        const w = p.lastForceSkippedWindow;
        const startMs = new Date(w.start).getTime();
        const endMs = new Date(w.end).getTime();
        const spanDays = Number.isFinite(startMs) && Number.isFinite(endMs)
          ? Math.max(0, (endMs - startMs) / (24 * 60 * 60 * 1000))
          : null;
        return {
          shopId: p.shopId,
          start: w.start,
          end: w.end,
          at: w.at || null,
          spanDays: spanDays == null ? null : Number(spanDays.toFixed(1)),
          completed: !!p.completed,
        };
      })
      .sort((a: any, b: any) => {
        const aAt = a.at ? new Date(a.at).getTime() : 0;
        const bAt = b.at ? new Date(b.at).getTime() : 0;
        return bAt - aAt;
      });
    const tekmetricForceSkippedTotalSpanDays = Number(
      tekmetricForceSkippedWindows
        .reduce((sum: number, w: any) => sum + (w.spanDays || 0), 0)
        .toFixed(1)
    );

    // Aggregate Tekmetric RO-skip stats. Distinct from force-skipped windows:
    // those are entire date ranges the cron jumped past, while these are
    // individual repair orders inside an otherwise-processed chunk that threw
    // and were silently dropped.
    const tekmetricRoSkipShops = tekmetricDiagnostics.filter(
      (d: any) => (d.consecutiveRoSkipRuns || 0) > 0,
    );
    const tekmetricRecurringRoSkipShops = tekmetricDiagnostics.filter((d: any) =>
      (d.reasons || []).includes("recurring_ro_skips"),
    );

    // Recovered = a shop that previously had silently-dropped ROs but is now
    // clean (no consecutive skip runs AND the rolling window has been cleared
    // by confirmed re-fetches). We surface these for ~14 days so on-call can
    // distinguish "currently dropping" from "historically dropped, now
    // recovered" instead of stale ids lingering on the live view forever.
    // Pulled from raw progress rows (not diagnostics) because completed shops
    // are filtered out of the stuck-diagnostics list but can still be
    // recently-recovered.
    const recoveredCutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const tekmetricRecoveredRoSkipShops = tekmetricBackfillProgress
      .filter((p: any) => {
        if ((Number(p.consecutiveRoSkipRuns) || 0) > 0) return false;
        if (Array.isArray(p.recentSkippedRos) && p.recentSkippedRos.length > 0) return false;
        const recoveredAt = p.roSkipsFullyRecoveredAt || p.lastSkippedRosResolvedAt;
        if (!recoveredAt) return false;
        return new Date(recoveredAt).getTime() >= recoveredCutoffMs;
      })
      .map((p: any) => ({
        shopId: p.shopId,
        completed: !!p.completed,
        roSkipsFullyRecoveredAt: p.roSkipsFullyRecoveredAt || null,
        lastSkippedRosResolvedAt: p.lastSkippedRosResolvedAt || null,
        resolvedSkippedRosTotal: Number(p.resolvedSkippedRosTotal || 0),
      }))
      .sort((a: any, b: any) => {
        const aAt = new Date(a.roSkipsFullyRecoveredAt || a.lastSkippedRosResolvedAt || 0).getTime();
        const bAt = new Date(b.roSkipsFullyRecoveredAt || b.lastSkippedRosResolvedAt || 0).getTime();
        return bAt - aAt;
      });

    const tekmetricStuckCount = tekmetricDiagnostics.filter((d: any) => d.stuck).length;

    const { rows: tekmetricChunkSpeed, slowChunkShopCount: tekmetricSlowChunkShopCount } =
      buildChunkSpeed("tekmetric", tekmetricBackfillProgress, chunkSpeedAlertsByKey);

    // Per-shop jobs-cache pre-warm overlay. The prewarm record lives on
    // `shops.tekmetric.jobsCachePrewarm` (stamped by
    // lib/tekmetric-jobs-prewarm.ts at onboarding). Joining it onto the
    // backfill-progress universe lets on-call confirm at a glance which
    // freshly onboarded shops actually got their pre-warm vs which ones
    // were onboarded before the feature shipped (no record at all) and
    // would benefit from a one-shot manual warm. We key the join on
    // String(shopId) since the platform shopId is sometimes stored as a
    // string and sometimes as a number across collections.
    const tekmetricPrewarmByShopId = new Map<string, any>();
    for (const s of tekmetricShopDocs as any[]) {
      tekmetricPrewarmByShopId.set(String(s.shopId), {
        tekmetricShopId: s?.tekmetric?.shopId ?? null,
        record: s?.tekmetric?.jobsCachePrewarm || null,
      });
    }

    // Inspections-endpoint token health overlay (task #279). The doc is
    // stamped by `getRepairOrderInspectionsWithXAuth` when a shop trips the
    // 401 short-circuit and cleared on the next 200. We only surface
    // currently-unauthorized shops so the panel auto-clears once the token
    // is fixed.
    const tekmetricInspectionsTokenHealth = (tekmetricShopDocs as any[])
      .map((s: any) => {
        const h = s?.tekmetric?.inspectionsTokenHealth;
        if (!h || h.status !== 'unauthorized') return null;
        return {
          shopId: s.shopId,
          tekmetricShopId: s?.tekmetric?.shopId ?? null,
          status: h.status,
          tokenFingerprint: h.tokenFingerprint || null,
          shortCircuitedAt: h.shortCircuitedAt || null,
          shortCircuitExpiresAt: h.shortCircuitExpiresAt || null,
          skippedRoCount: h.skippedRoCount ?? 0,
          consecutive401s: h.consecutive401s ?? 0,
          updatedAt: h.updatedAt || null,
        };
      })
      .filter((x: any) => x !== null);
    const tekmetricInspectionsTokenUnauthorizedShopCount =
      tekmetricInspectionsTokenHealth.length;
    const tekmetricInspectionsRosSkippedTotal = tekmetricInspectionsTokenHealth.reduce(
      (sum: number, h: any) => sum + (h.skippedRoCount || 0),
      0,
    );
    const tekmetricJobsCachePrewarm = tekmetricBackfillProgress
      .map((p: any) => {
        const entry = tekmetricPrewarmByShopId.get(String(p.shopId));
        const record = entry?.record || null;
        return {
          shopId: p.shopId,
          tekmetricShopId: entry?.tekmetricShopId ?? null,
          completed: !!p.completed,
          // `hasPrewarmRecord: false` is the visual "this shop was
          // onboarded before pre-warm rolled out" signal — it's the
          // primary thing on-call should be able to spot in the table.
          hasPrewarmRecord: !!record,
          completedAt: record?.completedAt || null,
          lookbackDays: record?.lookbackDays ?? null,
          rosScanned: record?.rosScanned ?? null,
          terminalRosFound: record?.terminalRosFound ?? null,
          alreadyCached: record?.alreadyCached ?? null,
          rosCached: record?.rosCached ?? null,
          jobsCached: record?.jobsCached ?? null,
          errors: record?.errors ?? null,
          capped: !!record?.capped,
          durationMs: record?.durationMs ?? null,
        };
      })
      .sort((a: any, b: any) => {
        // Surface "no prewarm record" rows first — they're the actionable
        // ones (legacy shops that never got warmed) — then capped /
        // errored, then most-recent prewarm.
        if (a.hasPrewarmRecord !== b.hasPrewarmRecord) {
          return a.hasPrewarmRecord ? 1 : -1;
        }
        const aProblem = (a.capped ? 1 : 0) + ((a.errors || 0) > 0 ? 1 : 0);
        const bProblem = (b.capped ? 1 : 0) + ((b.errors || 0) > 0 ? 1 : 0);
        if (aProblem !== bProblem) return bProblem - aProblem;
        const aAt = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bAt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return bAt - aAt;
      });
    const tekmetricJobsCachePrewarmMissingCount = tekmetricJobsCachePrewarm
      .filter((p: any) => !p.hasPrewarmRecord).length;
    const tekmetricJobsCachePrewarmCappedCount = tekmetricJobsCachePrewarm
      .filter((p: any) => p.capped).length;
    const tekmetricJobsCachePrewarmErrorsCount = tekmetricJobsCachePrewarm
      .filter((p: any) => (p.errors ?? 0) > 0).length;

    return NextResponse.json({
      complete: tekmetricShopsComplete,
      total: tekmetricShopsTotal,
      stuck: tekmetricStuckCount,
      progress: tekmetricBackfillProgress.map((p: any) => ({
        shopId: p.shopId,
        completed: p.completed,
        currentChunkEnd: p.currentChunkEnd,
        totalJobsIndexed: p.totalJobsIndexed,
        lastRunAt: p.lastRunAt,
      })),
      diagnostics: tekmetricDiagnostics,
      forceSkippedWindows: tekmetricForceSkippedWindows,
      forceSkippedShopCount: tekmetricForceSkippedWindows.length,
      forceSkippedTotalSpanDays: tekmetricForceSkippedTotalSpanDays,
      roSkipShopCount: tekmetricRoSkipShops.length,
      recurringRoSkipShopCount: tekmetricRecurringRoSkipShops.length,
      roSkipShops: tekmetricRoSkipShops.map((d: any) => ({
        shopId: d.shopId,
        consecutiveRoSkipRuns: d.consecutiveRoSkipRuns,
        lastRoSkipCount: d.lastRoSkipCount,
        lastRoSkipAt: d.lastRoSkipAt,
        recentSkippedRos: d.recentSkippedRos,
        stillFailingRoCount: d.stillFailingRoCount,
        permanentlyFailedRoCount: d.permanentlyFailedRoCount,
        recoveredRoCount: d.recoveredRoCount,
        lastRoRetryAt: d.lastRoRetryAt,
        lastRoRetryRecovered: d.lastRoRetryRecovered,
        lastRoRetryStillFailing: d.lastRoRetryStillFailing,
        lastRoRetryPermanentlyFailed: d.lastRoRetryPermanentlyFailed,
      })),
      roRecoveredTotal: tekmetricDiagnostics.reduce(
        (sum: number, d: any) => sum + (d.recoveredRoCount || 0),
        0,
      ),
      roPermanentlyFailedTotal: tekmetricDiagnostics.reduce(
        (sum: number, d: any) => sum + (d.permanentlyFailedRoCount || 0),
        0,
      ),
      roStillFailingTotal: tekmetricDiagnostics.reduce(
        (sum: number, d: any) => sum + (d.stillFailingRoCount || 0),
        0,
      ),
      recoveredRoSkipShops: tekmetricRecoveredRoSkipShops,
      recoveredRoSkipShopCount: tekmetricRecoveredRoSkipShops.length,
      // Stale-archived entries: ROs auto-archived after 30 days without
      // a re-fetch. Surfaced separately so on-call can spot cold leftovers
      // distinct from live actionable skips.
      staleArchivedSkippedRoShops: (tekmetricStaleArchivedAgg as any[]).map(
        (g: any) => ({
          shopId: g._id,
          entriesArchived: g.entriesArchived,
          lastArchivedAt: g.lastArchivedAt,
          oldestSkippedAt: g.oldestSkippedAt,
          permanentlyFailedCount: g.permanentlyFailedCount,
        }),
      ),
      staleArchivedSkippedRoShopCount: (tekmetricStaleArchivedAgg as any[])
        .length,
      staleArchivedSkippedRoTotal: (tekmetricStaleArchivedAgg as any[])
        .reduce(
          (sum: number, g: any) => sum + (g.entriesArchived || 0),
          0,
        ),
      // Per-chunk speed metrics. Median + p95 chunk duration and cache
      // hit rates per shop. Built from the rolling
      // `recentChunkMetrics` window persisted by the backfill cron so a
      // regression in chunk speed is visible without grepping cron logs.
      chunkSpeed: tekmetricChunkSpeed,
      chunkSpeedShopCount: tekmetricChunkSpeed.length,
      slowChunkShopCount: tekmetricSlowChunkShopCount,
      slowChunkP95ThresholdMs: SLOW_P95_THRESHOLD_MS,
      // Per-shop jobs-cache pre-warm status (task #59 / task #63).
      // `jobsCachePrewarmMissingCount` is the headline number on the
      // dashboard card — a non-zero value means there are legacy
      // Tekmetric shops onboarded before pre-warm shipped that
      // could be one-shot warmed manually for a faster first chunk.
      jobsCachePrewarm: tekmetricJobsCachePrewarm,
      jobsCachePrewarmShopCount: tekmetricJobsCachePrewarm.length,
      jobsCachePrewarmMissingCount: tekmetricJobsCachePrewarmMissingCount,
      jobsCachePrewarmCappedCount: tekmetricJobsCachePrewarmCappedCount,
      jobsCachePrewarmErrorsCount: tekmetricJobsCachePrewarmErrorsCount,
      // Inspections-endpoint x-auth-token health (task #279). Lists
      // shops whose inspections token is currently 401-short-circuited
      // along with the count of ROs whose inspections fetch was
      // suppressed for the window. Empty when all shops are healthy.
      inspectionsTokenHealth: tekmetricInspectionsTokenHealth,
      inspectionsTokenUnauthorizedShopCount:
        tekmetricInspectionsTokenUnauthorizedShopCount,
      inspectionsRosSkippedTotal: tekmetricInspectionsRosSkippedTotal,
      // Persisted catch-up run summaries (task #181). The
      // `scripts/tekmetric-catchup.mjs` runner writes one record per
      // run into `tekmetric_catchup_runs`; we expose the most-recent
      // few here so on-call can read the last SUMMARY blocks straight
      // from the UI instead of grepping a log.
      catchupRuns: tekmetricCatchupRuns,
      catchupRunCount: tekmetricCatchupRuns.length,
      // Per-shop catch-up coverage over the last N runs (task #287).
      // Same shape & semantics as /api/cron/catchup-status so on-call
      // gets identical numbers in the browser without needing the
      // CRON_SECRET-gated endpoint. Page renders this under
      // `data.backfill.tekmetric.catchupCoverage`.
      catchupCoverage: tekmetricCatchupCoverage,
    });
  } catch (error: any) {
    console.error("[Admin SyncHealth/Tekmetric] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
