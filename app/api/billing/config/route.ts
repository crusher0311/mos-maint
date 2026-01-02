import { NextResponse } from "next/server";
import { getBillingSettings } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getBillingSettings();

    return NextResponse.json({
      ok: true,
      config: {
        trialVinLimit: settings.trialVinLimit,
        skipTrialBonusVins: settings.skipTrialBonusVins,
        mosProIncludedVins: settings.mosProIncludedVins,
        mosProPrice: settings.mosProPrice,
      },
    });
  } catch (error: any) {
    console.error("Error fetching billing config:", error);
    return NextResponse.json({
      ok: true,
      config: {
        trialVinLimit: 10,
        skipTrialBonusVins: 50,
        mosProIncludedVins: 300,
        mosProPrice: 199,
      },
    });
  }
}
