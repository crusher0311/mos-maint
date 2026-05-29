/**
 * Agent-facing poll endpoint (task #542, Milestone 2).
 *
 *   GET /api/print-agent/jobs[?printerId=...]  -> { jobs: AgentPrintJob[] }
 *
 * Authenticated by the shop API key (`Authorization: Bearer <mos_...>` or
 * `X-API-Key`) via the existing external-api middleware. The `print:agent`
 * permission is required. Every claim is scoped to the API key's shopId,
 * so one shop's agent can never receive another shop's jobs.
 *
 * The cloud opens NO printer socket here — it only atomically claims the
 * next pending job and hands the persisted image payload to the agent.
 */

import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { claimNextJob, recordAgentPoll } from "@/lib/print-queue/repository";
import type { PollJobsResponse } from "@/lib/print-queue/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createExternalEndpoint(
  "print:agent",
  async (req: NextRequest, { shopId }) => {
    const printerId = req.nextUrl.searchParams.get("printerId");

    // Best-effort heartbeat so the platform-admin dashboard (Milestone 3)
    // can show "agent online / last seen". Never block a poll on it.
    try {
      const agentVersion =
        req.headers.get("x-agent-version") || req.nextUrl.searchParams.get("agentVersion");
      await recordAgentPoll(shopId, printerId, agentVersion);
    } catch (err: any) {
      console.warn("[Print Agent] heartbeat record failed:", err?.message);
    }

    const job = await claimNextJob(shopId, printerId);
    const body: PollJobsResponse = { jobs: job ? [job] : [] };
    return NextResponse.json(body);
  },
);
