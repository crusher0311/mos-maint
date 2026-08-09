import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The customer-facing a la carte add-ons catalog has been removed along
// with the self-serve billing page. Add-ons are managed internally
// (admin / platform-admin).
export async function GET() {
  return NextResponse.json(
    { error: "Self-serve add-ons are no longer available. Please contact support to change your plan." },
    { status: 410 },
  );
}
