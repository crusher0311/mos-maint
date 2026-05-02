import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Task #271: VIN-based billing has been removed. This endpoint is retained
// only to return a stable 410 Gone for any clients still calling it.
export async function POST() {
  return NextResponse.json(
    { error: "VIN packs have been retired. VINs are no longer a billing dimension." },
    { status: 410 }
  );
}
