import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Customer self-serve billing has been removed. Billing is managed
// internally (admin / platform-admin). Existing subscriptions keep billing
// normally via the Stripe webhook.
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    { error: "Self-serve billing management is no longer available. Please contact support with billing questions." },
    { status: 410 },
  );
}
