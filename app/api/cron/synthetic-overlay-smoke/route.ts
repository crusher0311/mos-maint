import { NextRequest, NextResponse } from "next/server";
import { runSyntheticSmoke } from "@/lib/synthetic/runner";
import { ALL_BROWSER_STEPS } from "@/lib/synthetic/browser-steps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Browser-driven synthetic for the Detect Dog overlay flow (task #527).
 *
 * Runs on a lower cadence than the API synthetic (every 30 min — entry
 * `synthetic-overlay-smoke` in `lib/cron/jobs.cjs`) because launching a
 * headless Chromium with the extension loaded is heavier than the
 * 5-min API smoke. It loads the extension against a recorded Tekmetric RO
 * page, clicks "Pre-fill DVI", and asserts the request fired + the UI
 * updated — catching content-script / DOM-selector regressions the
 * API-only synthetic (task #512) cannot see.
 *
 * Shares the runner with the API synthetic but is invoked with
 * `{ runner: "browser" }`, so:
 *   - results land in `synthetic_runs` tagged `runner:"browser"`,
 *   - `synthetic_state` dedup keys are namespaced (`step:browser:<name>`),
 *   - failure paging reuses the SAME 2-consecutive-failures dedup.
 *
 * DORMANT BY DEFAULT: the overlay step short-circuits to `ok:true` unless
 * `SYNTHETIC_BROWSER_ENABLED=true`, so this cron is a safe no-op on hosts
 * without an extension-capable Chromium. See
 * `docs/runbooks/synthetic-prod-smoke.md`.
 *
 * BREAK GLASS: `SYNTHETIC_SMOKE_DISABLED=true` mutes both synthetics.
 */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / local
  const auth = req.headers.get("authorization") || "";
  const qs = req.nextUrl.searchParams.get("secret");
  return auth === `Bearer ${secret}` || qs === secret;
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.SYNTHETIC_SMOKE_DISABLED === "true") {
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }
  try {
    const summary = await runSyntheticSmoke({
      runner: "browser",
      steps: ALL_BROWSER_STEPS,
    });
    return NextResponse.json({
      ok: summary.ok,
      runner: summary.runner,
      durationMs: summary.durationMs,
      steps: summary.steps.map((r) => ({
        name: r.name,
        ok: r.ok,
        latencyMs: r.latencyMs,
        status: r.status,
        error: r.error,
        extra: r.extra,
      })),
      alerts: summary.alerts,
    });
  } catch (err: any) {
    console.error("[SyntheticOverlay] runner threw:", err?.message || err);
    return NextResponse.json(
      { ok: false, error: err?.message || "runner_error" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
