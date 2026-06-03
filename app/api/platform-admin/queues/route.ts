/**
 * Platform-admin queue dashboard JSON endpoint (task #513).
 *
 * Platform-admin only. Returns counts per queue and the "needs-human"
 * failed-jobs sample. This is the BullBoard-equivalent for the
 * project — a thin JSON over `lib/queue/metrics.ts` that the admin UI
 * (`app/platform-admin/queues/page.tsx`) renders.
 *
 * BullBoard's UI itself wasn't a clean fit: it ships an Express adapter
 * that doesn't compose with Next's app router without a separate
 * Node server. The data is what matters; rendering it through the
 * existing admin styling keeps the access controls consistent with
 * every other sync-health surface.
 */

import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { isQueueEnabled } from "@/lib/queue/connection";
import {
  getAllQueueSnapshots,
  getFailedJobs,
} from "@/lib/queue/metrics";
import { retryFailedJob } from "@/lib/queue/actions";
import { ALL_QUEUE_NAMES, type QueueName } from "@/lib/queue/queues";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isQueueEnabled()) {
    return NextResponse.json({
      ok: true,
      enabled: false,
      message:
        "REDIS_URL is not set. The backfill worker queue is not enabled in this environment. See docs/runbooks/worker-queue-cutover.md.",
      queues: [],
      failedJobs: [],
    });
  }

  const snapshots = await getAllQueueSnapshots();
  const failedJobs: any[] = [];
  for (const name of ALL_QUEUE_NAMES) {
    const fj = await getFailedJobs(name, 20);
    if (fj && fj.length > 0) {
      failedJobs.push(...fj.map((j) => ({ ...j, queue: name })));
    }
  }

  return NextResponse.json({
    ok: true,
    enabled: true,
    generatedAt: new Date().toISOString(),
    queues: snapshots,
    failedJobs,
  });
}

/**
 * Operator actions on the queues. Currently the single supported action
 * is `retry`, which re-enqueues a dead-lettered (failed) job — closing
 * the script-only gap noted in the cutover runbook.
 *
 * Body: { action: "retry", queue: <queueName>, jobId: <id> }
 */
export async function POST(req: Request) {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isQueueEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "REDIS_URL is not set. The backfill worker queue is not enabled in this environment.",
      },
      { status: 400 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (body?.action !== "retry") {
    return NextResponse.json(
      { ok: false, error: `Unknown action: ${body?.action ?? "(none)"}` },
      { status: 400 },
    );
  }

  const queue = body?.queue as QueueName;
  const jobId = body?.jobId;
  if (!ALL_QUEUE_NAMES.includes(queue)) {
    return NextResponse.json(
      { ok: false, error: `Unknown queue: ${String(queue)}` },
      { status: 400 },
    );
  }
  if (typeof jobId !== "string" || jobId.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Missing jobId" },
      { status: 400 },
    );
  }

  const result = await retryFailedJob(queue, jobId);
  if (result.ok) {
    return NextResponse.json(result);
  }
  const status = result.reason === "not_found" ? 404 : 400;
  return NextResponse.json(result, { status });
}
