import { NextRequest, NextResponse } from "next/server";
import {
  fetchRenderService,
  suspendRenderService,
  resumeRenderService,
} from "@/lib/render-api";

/**
 * Worker power scheduler (suspend/resume the MOS background workers).
 *
 * Driven by two in-process cron jobs registered in `lib/cron/jobs.cjs`:
 *   - worker-resume-nightly  (10:00pm America/Chicago, Mon-Fri) -> ?action=resume
 *   - worker-pause-morning   (05:00am America/Chicago, Mon-Fri) -> ?action=pause
 *
 * Net effect: the workers run nights Mon-Fri PLUS the full weekend (Fri 10pm
 * -> Mon 5am, with no Sat/Sun pause), and are off only during weekday daytime
 * (Mon-Fri 5am-10pm Central). This keeps the heavy backfill drain off the
 * shared MongoDB during business hours (it has previously saturated Mongo and
 * caused fleet-wide login/timeout symptoms) while still letting it catch up
 * overnight and on weekends.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` (same as every other
 * cron route). Idempotent: it reads each service's current suspended state and
 * only calls Render when a change is actually needed. Safety: it will only
 * act on `background_worker` services, never the web service.
 *
 * Kill switch: set WORKER_SCHEDULE_DISABLED=true on Render to make the
 * scheduled fires a no-op without removing the cron entries.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Default to the two MOS background workers. Override with
// WORKER_SCHEDULE_SERVICE_IDS (comma-separated Render service IDs) if the
// worker set ever changes — no code change needed.
const DEFAULT_WORKER_SERVICE_IDS = [
  "srv-d86qipd7vvec73ahur00", // backfill-drain-worker
  "srv-d8g15v3eo5us73fvajhg", // mos-maint-background-v2
];

function workerServiceIds(): string[] {
  const raw = process.env.WORKER_SCHEDULE_SERVICE_IDS;
  if (raw && raw.trim()) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_WORKER_SERVICE_IDS;
}

type WorkerResult = {
  id: string;
  name?: string;
  action: string;
  type?: string;
  status?: number;
  ok?: boolean;
  error?: string;
};

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
  if (expected && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.WORKER_SCHEDULE_DISABLED === "true") {
    console.log("[WorkerPower] WORKER_SCHEDULE_DISABLED=true — skipping");
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }

  const action = (req.nextUrl.searchParams.get("action") || "").toLowerCase();
  if (action !== "resume" && action !== "pause") {
    return NextResponse.json(
      { error: "Invalid action. Use ?action=resume or ?action=pause" },
      { status: 400 },
    );
  }

  const apiKey = process.env.RENDER_API_KEY_PROD;
  if (!apiKey) {
    console.error("[WorkerPower] RENDER_API_KEY_PROD not set — cannot manage workers");
    return NextResponse.json(
      { error: "RENDER_API_KEY_PROD not configured" },
      { status: 500 },
    );
  }

  const ids = workerServiceIds();
  const results: WorkerResult[] = [];

  for (const id of ids) {
    try {
      const svc = await fetchRenderService(apiKey, id, "worker-power");

      // Safety net: only ever touch background workers. Never suspend the web
      // service, even if it is mistakenly listed in the env override.
      if (svc.type !== "background_worker") {
        console.warn(
          `[WorkerPower] Skipping ${id} (${svc.name}) — type=${svc.type}, not a background_worker`,
        );
        results.push({ id, name: svc.name, action: "skipped_not_worker", type: svc.type });
        continue;
      }

      const isSuspended = svc.suspended === "suspended";

      if (action === "resume") {
        if (!isSuspended) {
          results.push({ id, name: svc.name, action: "already_running" });
          continue;
        }
        const r = await resumeRenderService(apiKey, id, "worker-power");
        results.push({ id, name: svc.name, action: "resumed", status: r.status, ok: r.ok });
        console.log(`[WorkerPower] Resumed ${svc.name} (${id}) → HTTP ${r.status}`);
      } else {
        if (isSuspended) {
          results.push({ id, name: svc.name, action: "already_paused" });
          continue;
        }
        const r = await suspendRenderService(apiKey, id, "worker-power");
        results.push({ id, name: svc.name, action: "paused", status: r.status, ok: r.ok });
        console.log(`[WorkerPower] Paused ${svc.name} (${id}) → HTTP ${r.status}`);
      }
    } catch (err: any) {
      console.error(`[WorkerPower] Failed for ${id}:`, err?.message || err);
      results.push({ id, action: "error", error: err?.message || String(err) });
    }
  }

  // Treat any per-worker failure (an exception, or a non-2xx from Render) as a
  // failed cron run. The in-process scheduler keys success on the HTTP status,
  // so returning 200 here when a suspend/resume actually failed would let the
  // cron-health alerter believe the schedule is working while the workers are
  // stuck in the wrong power state. Surface it as 500 instead.
  const failed = results.some(
    (r) => r.action === "error" || r.ok === false,
  );

  console.log(
    `[WorkerPower] action=${action} failed=${failed} results=${JSON.stringify(results)}`,
  );
  return NextResponse.json({ ok: !failed, action, results }, { status: failed ? 500 : 200 });
}
