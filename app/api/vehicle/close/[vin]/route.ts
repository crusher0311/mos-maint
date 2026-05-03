import { NextResponse } from "next/server";
import { insertEvent } from "@/lib/data/repositories/events";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ vin: string }> }
) {
  const { vin } = await ctx.params;
  const url = new URL(req.url);
  const redirectTo = url.searchParams.get("redirect");

  const cleanVin = (vin || "").toUpperCase();
  if (!cleanVin || cleanVin.length < 6) {
    return NextResponse.json({ error: "Invalid VIN" }, { status: 400 });
  }

  // Immutable log event
  await insertEvent({
    provider: "ui",
    type: "manual_closed",
    vehicleVin: cleanVin,
    status: "Closed",
    createdAt: new Date(),
    payload: { reason: "manual_close_from_dashboard" },
  } as any);

  if (redirectTo) {
    return NextResponse.redirect(new URL(redirectTo, url), 303);
  }

  return NextResponse.json({ ok: true, vin: cleanVin });
}
