import { NextRequest, NextResponse } from "next/server";
import { computeAndStoreProfiles } from "@/lib/data/repositories/activity-profiles";
import { getSmartBackfillTimingMode } from "@/lib/integrations/activity-profile/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Daily compute of per-shop activity profiles for the smart-backfill-timing
 * feature (task #662).
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` (same as the other
 * crons under /api/cron/).
 *
 * Behavior gate: when `SMART_BACKFILL_TIMING` is unset/off this route is a
 * no-op — it performs NO Mongo reads or writes, so the feature being off costs
 * nothing. An operator can still force a one-off recompute with `?force=1`
 * (used to populate / refresh profiles before flipping the flag to observe).
 *
 * All DB I/O lives in `lib/data/repositories/activity-profiles.ts`; this route
 * imports only that repository (so it passes scripts/check-direct-db.cjs).
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const force = ["1", "true", "yes"].includes(
    (url.searchParams.get("force") || "").toLowerCase(),
  );
  const mode = getSmartBackfillTimingMode();

  if (mode === "off" && !force) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      mode,
      reason: "SMART_BACKFILL_TIMING is off; pass ?force=1 to compute anyway",
    });
  }

  const startedAt = Date.now();
  try {
    const result = await computeAndStoreProfiles();
    return NextResponse.json({
      ok: true,
      mode,
      forced: force,
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (err: any) {
    console.error(
      `[compute-activity-profiles] failed: ${err?.message || err}`,
    );
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
