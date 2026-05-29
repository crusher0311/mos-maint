/**
 * Agent-facing ack endpoint (task #542, Milestone 2).
 *
 *   POST /api/print-agent/jobs/:id/ack   body: AckJobRequest -> { ok }
 *
 * Authenticated by the shop API key via the external-api middleware
 * (`print:agent` permission). The job id is parsed from the path because
 * the external-api wrapper does not thread Next's dynamic route params.
 *
 * Scoped by the API key's shopId — `ackJob` only matches a job that
 * belongs to this shop, so a foreign agent's ack is a 404, never a
 * cross-shop state mutation.
 */

import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { ackJob } from "@/lib/print-queue/repository";
import type { AckJobRequest, AckJobResponse } from "@/lib/print-queue/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseJobId(req: NextRequest): string | null {
  // /api/print-agent/jobs/<id>/ack
  const parts = req.nextUrl.pathname.split("/").filter(Boolean);
  const ackIdx = parts.lastIndexOf("ack");
  if (ackIdx < 1) return null;
  const id = parts[ackIdx - 1];
  return id || null;
}

export const POST = createExternalEndpoint(
  "print:agent",
  async (req: NextRequest, { shopId }) => {
    const jobId = parseJobId(req);
    if (!jobId) {
      return NextResponse.json({ error: "Missing job id" }, { status: 400 });
    }

    let body: AckJobRequest;
    try {
      body = (await req.json()) as AckJobRequest;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (body?.status !== "success" && body?.status !== "failure") {
      return NextResponse.json(
        { error: "status must be 'success' or 'failure'" },
        { status: 400 },
      );
    }

    const result = await ackJob(shopId, jobId, body.status, {
      error: body.error,
      durationMs: body.durationMs,
      agentVersion: body.agentVersion,
    });

    if (result === "not_found") {
      return NextResponse.json({ ok: false, error: "Job not found" }, { status: 404 });
    }

    const res: AckJobResponse = { ok: true };
    return NextResponse.json(res);
  },
);
