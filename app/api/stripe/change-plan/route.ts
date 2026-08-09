import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Customer self-serve billing has been removed. Plan changes are handled
// internally (admin / platform-admin). Existing subscriptions keep billing
// normally via the Stripe webhook.
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    { error: "Self-serve plan changes are no longer available. Please contact support to change your plan." },
    { status: 410 },
  );
}
