import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ vin: string }> }
) {
  const { vin } = await ctx.params;
  const url = new URL(req.url);
  const redirectTo = url.searchParams.get("redirect"); // e.g. /dashboard

  const cleanVin = (vin || "").toUpperCase();
  if (!cleanVin || cleanVin.length < 6) {
    return NextResponse.json({ error: "Invalid VIN" }, { status: 400 });
  }

  const db = await getDb();

  // Immutable log event
  await db.collection("events").insertOne({
    provider: "ui",
    type: "manual_closed",
    vehicleVin: cleanVin,
    status: "Closed",
    createdAt: new Date(),
    payload: { reason: "manual_close_from_dashboard" },
  });

  // If caller asked for a redirect, send them there (back to dashboard)
  if (redirectTo) {
    // 303 ensures the browser does a GET to the redirect location
    return NextResponse.redirect(new URL(redirectTo, url), 303);
  }

  // Default JSON (useful for programmatic calls)
  return NextResponse.json({ ok: true, vin: cleanVin });
}
