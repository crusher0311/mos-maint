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
        mosProPrice: settings.mosProPrice,
      },
    });
  } catch (error: any) {
    console.error("Error fetching billing config:", error);
    return NextResponse.json({
      ok: true,
      config: {
        mosProPrice: 199,
      },
    });
  }
}
