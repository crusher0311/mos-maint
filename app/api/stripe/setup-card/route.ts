import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Customer self-serve card setup has been removed. Card-capture links are
// now sent by admins via email (lib/card-capture-resend.ts calls
// createCardSetupSession directly server-side, not through this route).
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    { error: "Self-serve card setup is no longer available. Please contact support to update your payment method." },
    { status: 410 },
  );
}
