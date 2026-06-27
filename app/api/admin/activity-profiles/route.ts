import { NextRequest, NextResponse } from "next/server";
import { getAllActivityProfiles } from "@/lib/data/repositories/activity-profiles";
import {
  getMachineBurstThreshold,
  getQuietWindowMinConfidence,
  getSmartBackfillTimingMode,
  decideQuietWindowGate,
  describeGateDecision,
} from "@/lib/integrations/activity-profile/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only operator readout for the smart-backfill-timing feature (task #662).
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` (same as the other
 * status endpoints), so it can be polled from a shell / CI without a browser
 * session. Intentionally NOT a platform-admin page route.
 *
 * Shows the current flag mode, thresholds, every computed profile, and what
 * the gate WOULD decide right now for each shop (so an operator can sanity
 * check coverage and confidence before flipping the flag to observe/enforce).
 *
 * Imports only the repository (no `@/lib/mongo`) so it passes
 * scripts/check-direct-db.cjs.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();
    const mode = getSmartBackfillTimingMode();
    const minConfidence = getQuietWindowMinConfidence();
    const profiles = await getAllActivityProfiles();

    const rows = profiles.map((p) => {
      const decision = decideQuietWindowGate({ profile: p, now, minConfidence });
      return {
        shopId: p.shopId,
        provider: p.provider,
        timezone: p.timezone,
        timezoneSource: p.timezoneSource,
        confidence: p.confidence,
        primaryQuietWindow: p.primaryQuietWindow,
        quietWindows: p.quietWindows,
        totalOrganicEvents: p.totalOrganicEvents,
        machineEventsFiltered: p.machineEventsFiltered,
        distinctActiveDays: p.distinctActiveDays,
        sampleWindowDays: p.sampleWindowDays,
        perProviderCounts: p.perProviderCounts,
        computedAt: p.computedAt,
        decisionNow: {
          eligible: decision.eligible,
          fallback: decision.fallback,
          reason: decision.reason,
          localHour: decision.localHour,
          summary: describeGateDecision(p.shopId, decision),
        },
      };
    });

    const summary = {
      total: rows.length,
      confident: rows.filter((r) => r.confidence >= minConfidence).length,
      wouldBlockNow: rows.filter(
        (r) => !r.decisionNow.fallback && !r.decisionNow.eligible,
      ).length,
      fallbackNow: rows.filter((r) => r.decisionNow.fallback).length,
    };

    return NextResponse.json({
      ok: true,
      mode,
      minConfidence,
      machineBurstThreshold: getMachineBurstThreshold(),
      now: now.toISOString(),
      summary,
      profiles: rows,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
