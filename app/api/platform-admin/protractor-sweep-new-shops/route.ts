import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { insertAuditLog } from "@/lib/data/repositories/audit-logs";
import {
  findNewShopSweepCandidates,
  sweepNewProtractorShops,
} from "@/lib/integrations/protractor/new-shop-sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Platform-admin one-shot trigger for the Protractor new-shop drain sweep
 * (task #547). Drives every incomplete, recently-onboarded Protractor shop to
 * completion immediately, independent of the cron scheduler.
 *
 * Driving shops to completion can take far longer than the route's maxDuration
 * (each shop's drive can run up to 30 min of wall clock and may loop), so this
 * endpoint resolves the candidate list synchronously, launches the sweep in the
 * background (fire-and-forget — same pattern as the Protractor backfill cron's
 * default run-now path), and returns the candidate list right away. Per-shop
 * progress and the final summary land in the server logs. Operators who want a
 * blocking summary with an exit code use `npm run sweep:protractor-new-shops`.
 *
 * Body (optional JSON): { shopIds?: number[], windowDays?: number }
 *   - shopIds: explicit allowlist for just this weekend's shops (bypasses the
 *     createdAt window; still filtered to incomplete shops).
 *   - windowDays: override the recently-onboarded window.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { shopIds?: unknown; windowDays?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // No/invalid body is fine — default to the window-based sweep.
  }

  const shopIds = Array.isArray(body.shopIds)
    ? body.shopIds
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
    : undefined;
  const windowDays =
    typeof body.windowDays === "number" && body.windowDays > 0
      ? body.windowDays
      : undefined;

  // Resolve candidates up front so the operator gets immediate feedback on
  // exactly which shops will be swept (and a fast "nothing to do" path).
  const { jobs, usedExplicitShopIds, windowDays: effectiveWindowDays } =
    await findNewShopSweepCandidates({ shopIds, windowDays });

  console.log(
    `[Platform Admin] Protractor new-shop sweep requested by ${session.email}: ` +
      `${jobs.length} candidate(s) ` +
      (usedExplicitShopIds
        ? `(explicit shopIds=[${jobs.map((j) => j.shopId).join(",")}])`
        : `(window=${effectiveWindowDays}d)`),
  );

  await insertAuditLog({
    type: "protractor_new_shop_sweep_started",
    adminEmail: session.email,
    candidateShopIds: jobs.map((j) => j.shopId),
    candidateShopCount: jobs.length,
    usedExplicitShopIds,
    windowDays: effectiveWindowDays,
  });

  if (jobs.length === 0) {
    return NextResponse.json({
      ok: true,
      started: false,
      candidateShopIds: [],
      candidateShopCount: 0,
      usedExplicitShopIds,
      windowDays: effectiveWindowDays,
      message: usedExplicitShopIds
        ? "None of the requested shops are incomplete Protractor shops."
        : `No incomplete Protractor shops onboarded in the last ${effectiveWindowDays} day(s).`,
    });
  }

  // Fire-and-forget: launch the sweep without awaiting so the HTTP response
  // returns promptly. Each shop's drive honors the per-shop in-flight/stale
  // lock and the Protractor rate limiter, so this can run alongside the cron
  // without double-running a shop or breaching API limits.
  sweepNewProtractorShops({ shopIds, windowDays })
    .then((summary) => {
      console.log(
        `[Platform Admin] Protractor new-shop sweep finished (by ${session.email}): ` +
          `swept=${summary.swept} complete=${summary.completed} ` +
          `pending=${summary.stillPending} errored=${summary.errored}`,
      );
      return insertAuditLog({
        type: "protractor_new_shop_sweep_completed",
        adminEmail: session.email,
        swept: summary.swept,
        completed: summary.completed,
        stillPending: summary.stillPending,
        errored: summary.errored,
        stopped: summary.stopped,
        totalChunks: summary.totalChunks,
        totalJobsIndexed: summary.totalJobsIndexed,
        durationMs: summary.durationMs,
      });
    })
    .catch((err: any) => {
      console.error(
        `[Platform Admin] Protractor new-shop sweep failed (by ${session.email}):`,
        err?.message || err,
      );
    });

  return NextResponse.json({
    ok: true,
    started: true,
    candidateShopIds: jobs.map((j) => j.shopId),
    candidateShopCount: jobs.length,
    usedExplicitShopIds,
    windowDays: effectiveWindowDays,
    message:
      `Sweeping ${jobs.length} Protractor shop(s) to completion in the background. ` +
      `Watch the server logs (filter: ProtractorNewShopSweep) for per-shop progress.`,
  });
}
