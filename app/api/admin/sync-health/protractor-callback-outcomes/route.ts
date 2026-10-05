import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getCallbackOutcomeReport } from "@/lib/data/repositories/protractor-callback-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bounded, read-only callback outcome report for platform-admin triage.
 *
 * The repository owns the sampling window and redaction boundary. This route
 * intentionally has no provider, queue, or worker invocation path.
 */
export async function GET() {
  try {
    await requirePlatformAdmin();
    const report = await getCallbackOutcomeReport();
    return NextResponse.json(report);
  } catch (error: any) {
    // requirePlatformAdmin() denies via redirect() — rethrow so Next.js
    // performs the redirect instead of turning an auth denial into a 500.
    if (error?.digest?.startsWith?.("NEXT_REDIRECT")) throw error;
    console.error("[Admin SyncHealth/ProtractorCallbackOutcomes] Report unavailable");
    return NextResponse.json(
      { error: "Failed to load callback outcome report" },
      { status: 500 },
    );
  }
}