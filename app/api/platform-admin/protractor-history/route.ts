import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { fleetHistoryStatus, saveFleetHistoryConfig, controlFleetHistory } from "@/lib/integrations/protractor/fleet-history";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function denied(req?: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) return NextResponse.json({ error: "Platform administrator required" }, { status: 403 });
  if (req) {
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  return null;
}
export async function GET() {
  const failure = await denied(); if (failure) return failure;
  try { return NextResponse.json(await fleetHistoryStatus(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "History status is unavailable; no settings changed" }, { status: 503 }); }
}
export async function PUT(req: NextRequest) {
  const failure = await denied(req); if (failure) return failure;
  try {
    const body = await req.json();
    return NextResponse.json({ config: await saveFleetHistoryConfig(body.config, body.confirmedHours) });
  } catch { return NextResponse.json({ error: "Settings were invalid or changed concurrently. Reload and review before saving." }, { status: 409 }); }
}
export async function POST(req: NextRequest) {
  const failure = await denied(req); if (failure) return failure;
  try { const b = await req.json(); return NextResponse.json(await controlFleetHistory(b.shopId, b.action)); }
  catch { return NextResponse.json({ error: "Action could not be confirmed. Reload status before retrying." }, { status: 409 }); }
}
