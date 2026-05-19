import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { isCofireEnabled, runCofireStress } from "@/lib/backfill-metrics/cofire-trigger";

export const dynamic = "force-dynamic";

// Co-fire stress trigger for backfill cadence measurement (task #460).
//
// Fires Tekmetric + Protractor + Shop-Ware backfill cron endpoints in
// parallel so peak combined write load can be measured without waiting
// for the natural 15-min stagger to align. Out of scope for this task is
// changing the actual cadence — this endpoint only exists to *measure*.
//
// Safety:
//   - Platform-admin auth required (same as the sync-health endpoints).
//   - Env flag `BACKFILL_COFIRE_STRESS=true` must be set, OR the request
//     body must explicitly include `{ "override": true }`. The flag is
//     the default opt-in for scheduled measurement windows; the body
//     override is the manual escape hatch on production for an on-call
//     human to fire one without an env change + restart.
//   - Each provider hit is bounded by a 5-minute fetch timeout so a hung
//     cron route cannot pin the admin request indefinitely.
export async function POST(req: Request) {
  try {
    await requirePlatformAdmin();
  } catch (err: any) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!isCofireEnabled() && body?.override !== true) {
    return NextResponse.json(
      {
        error:
          "Co-fire stress is disabled. Set BACKFILL_COFIRE_STRESS=true or POST { override: true } to fire manually.",
      },
      { status: 403 },
    );
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not set — cron endpoints would reject" },
      { status: 500 },
    );
  }

  const port = process.env.PORT || "5000";
  const baseUrl = process.env.CRON_BASE_URL || `http://127.0.0.1:${port}`;

  console.log(
    `[BackfillCofire] firing co-fire stress (override=${body?.override === true}) baseUrl=${baseUrl}`,
  );

  const { startedAt, results } = await runCofireStress({ baseUrl, cronSecret });

  return NextResponse.json({
    startedAt,
    finishedAt: new Date(),
    triggeredBy: body?.override === true ? "manual-override" : "env-flag",
    results,
  });
}
