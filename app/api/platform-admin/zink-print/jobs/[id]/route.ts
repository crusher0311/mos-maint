/**
 * Platform-admin ZINK job controls (task #543, Milestone 3).
 *
 *   POST /api/platform-admin/zink-print/jobs/:id
 *     body: { action: "requeue" | "clear", shopId }
 *     -> { ok, result }
 *
 * `requeue` resets a failed/stuck job back to pending so the next agent
 * poll re-claims it; `clear` permanently removes it. Both reuse the
 * shopId-scoped repository ops, so an admin can never mutate a job under
 * the wrong shop (`shopId` is required and must match the job's owner).
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { requeueJob, clearJob } from "@/lib/print-queue/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseJobId(req: NextRequest): string | null {
  // /api/platform-admin/zink-print/jobs/<id>
  const parts = req.nextUrl.pathname.split("/").filter(Boolean);
  const jobsIdx = parts.lastIndexOf("jobs");
  if (jobsIdx < 0 || jobsIdx + 1 >= parts.length) return null;
  return parts[jobsIdx + 1] || null;
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();

    const jobId = parseJobId(req);
    if (!jobId) {
      return NextResponse.json({ error: "Missing job id" }, { status: 400 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const shopId = Number(body?.shopId);
    if (!Number.isFinite(shopId) || shopId <= 0) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400 });
    }

    const action = body?.action;
    if (action !== "requeue" && action !== "clear") {
      return NextResponse.json(
        { error: "action must be 'requeue' or 'clear'" },
        { status: 400 },
      );
    }

    const result =
      action === "requeue"
        ? await requeueJob(shopId, jobId)
        : await clearJob(shopId, jobId);

    if (result === "not_found") {
      return NextResponse.json(
        { ok: false, error: "Job not found for this shop" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true, result });
  } catch (error: any) {
    if (
      typeof error?.digest === "string" &&
      error.digest.startsWith("NEXT_REDIRECT")
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[Admin ZINK Print] job control error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to update job" },
      { status: 500 },
    );
  }
}
