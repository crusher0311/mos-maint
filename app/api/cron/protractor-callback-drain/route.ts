import { NextRequest, NextResponse } from "next/server";
import { processProtractorCallbackDrain } from "@/lib/integrations/protractor/callback-drain";
import { getProtractorOutboundPolicy } from "@/lib/integrations/protractor/client";
import { logProtractorPolicyDenial } from "@/lib/integrations/protractor/outbound-policy.cjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Dedicated callback-only drain. Unlike protractor-sync this route performs
 * no shop sweep or active-list read, so it can run frequently without turning
 * callback recovery into a second full synchronization.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const policy = getProtractorOutboundPolicy();
  if (!policy.allowed) {
    logProtractorPolicyDenial(policy, "cron_protractor_callback_drain");
    return NextResponse.json({ ok: true, skipped: "local_instance_policy" });
  }
  try {
    const result = await processProtractorCallbackDrain();
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    console.error("[Protractor callback drain] failed:", error?.message || error);
    return NextResponse.json({ ok: false, error: "Callback drain failed" }, { status: 500 });
  }
}