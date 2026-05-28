import { NextRequest, NextResponse } from "next/server";
import { runSyntheticSmoke } from "@/lib/synthetic/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Synthetic prod smoke (task #512).
 *
 * Executes the top user-visible actions against a sentinel shop +
 * sentinel VIN every 5 minutes, persists per-step latency + pass/fail,
 * and pages platform admins when the same step fails twice in a row.
 *
 * Runner choice: in-process cron via `lib/cron/jobs.cjs` (entry
 * `synthetic-prod-smoke`). This route is also reachable externally by
 * any uptime monitor (`Authorization: Bearer ${CRON_SECRET}`), which
 * gives us the "catch a Render-side outage too" property — if the in-
 * process cron stops firing because the web service is down, an external
 * uptime monitor curling this endpoint will surface the outage as a
 * monitor failure even though the synthetic itself never reports.
 *
 * Status surface: `/admin/synthetic-prod-smoke` (read-only tile).
 * Runbook: `docs/runbooks/synthetic-prod-smoke.md`.
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
    const summary = await runSyntheticSmoke();
    // Always return 200 — the synthetic itself does not fail the cron
    // (we want the cron-health alerter to stay green; failure paging is
    // owned by the runner via email + `[ShopErrorRate]`).
    return NextResponse.json({
      ok: summary.ok,
      durationMs: summary.durationMs,
      steps: summary.steps.map((r) => ({
        name: r.name,
        ok: r.ok,
        latencyMs: r.latencyMs,
        status: r.status,
        error: r.error,
      })),
      alerts: summary.alerts,
    });
  } catch (err: any) {
    console.error("[SyntheticSmoke] runner threw:", err?.message || err);
    return NextResponse.json(
      { ok: false, error: err?.message || "runner_error" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
