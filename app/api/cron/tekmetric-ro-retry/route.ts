import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { runWithTekmetricPriority, runWithTekmetricApiCallTracking } from "@/lib/integrations/tekmetric/client";
import { runRetry } from "@/lib/integrations/tekmetric/ro-retry-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const CRON_SECRET = process.env.CRON_SECRET;

// Task: cron/backfill Tekmetric traffic must yield to advisor-facing
// requests — bind ambient 'background' rate-limit priority for the
// whole handler so every Tekmetric call under it inherits it.
export async function GET(req: NextRequest) {
  return runWithTekmetricPriority("background", () => _GETImpl(req));
}

async function _GETImpl(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.TEKMETRIC_CLIENT_ID || !process.env.TEKMETRIC_CLIENT_SECRET) {
    return NextResponse.json({ error: "Tekmetric OAuth credentials not configured" }, { status: 500 });
  }

  const db = await getDb();
  const startTime = Date.now();

  // Wrap the whole retry cycle in an AsyncLocalStorage scope so the
  // API-call count we report is *this* run's calls only — not leaked
  // from any other concurrent Tekmetric operation in the same Node
  // process (e.g. a backfill cron tick or admin-triggered retry).
  return runWithTekmetricApiCallTracking(async (apiCallCounter) => {
    try {
      const summary = await runRetry(db);
      const apiCalls = apiCallCounter.count;
      const duration = Date.now() - startTime;
      console.log(
        `[Cron] Tekmetric RO retry: ${summary.totalRecovered} recovered, ${summary.totalStillFailing} still failing, ${summary.totalPermanentlyFailed} permanently failed (API calls: ${apiCalls}, ${duration}ms)`,
      );
      return NextResponse.json({ ok: true, ...summary, tekmetricApiCalls: apiCalls, duration: `${duration}ms` });
    } catch (err: any) {
      const apiCalls = apiCallCounter.count;
      console.error("[Tekmetric RO Retry] Error:", err);
      return NextResponse.json({ error: err.message, tekmetricApiCalls: apiCalls }, { status: 500 });
    }
  });
}

// Task: cron/backfill Tekmetric traffic must yield to advisor-facing
// requests — bind ambient 'background' rate-limit priority for the
// whole handler so every Tekmetric call under it inherits it.
export async function POST(req: NextRequest) {
  return runWithTekmetricPriority("background", () => _POSTImpl(req));
}

async function _POSTImpl(req: NextRequest) {
  // Same handler — allow on-demand POST trigger from admin UI.
  return GET(req);
}
