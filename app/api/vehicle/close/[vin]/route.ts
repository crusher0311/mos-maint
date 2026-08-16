import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { insertEvent } from "@/lib/data/repositories/events";

export const dynamic = "force-dynamic";

/** Test seam — swap these in unit tests to avoid real DB / auth calls. */
export const __deps = { getSession, getDb, insertEvent };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ vin: string }> }
) {
  const session = await __deps.getSession();
  if (!session?.shopId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shopId = Number(session.shopId);

  const { vin } = await ctx.params;
  const url = new URL(req.url);
  const redirectTo = url.searchParams.get("redirect");

  const cleanVin = (vin || "").toUpperCase();
  if (!cleanVin || cleanVin.length < 6) {
    return NextResponse.json({ error: "Invalid VIN" }, { status: 400 });
  }

  // Verify the VIN belongs to the authenticated shop before writing any event.
  // A caller who posts a foreign VIN in the URL gets a 404 rather than a 403
  // to avoid leaking whether that VIN exists in the system at all.
  const db = await __deps.getDb();
  const vehicle = await db.collection("vehicles").findOne(
    { vin: cleanVin, $or: [{ shopId: String(shopId) }, { shopId: shopId }] },
    { projection: { _id: 1 } }
  );
  if (!vehicle) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  // Immutable log event — include shopId so it can be scoped in queries.
  await __deps.insertEvent({
    provider: "ui",
    type: "manual_closed",
    shopId,
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
