// app/api/vehicles/[vin]/refresh/route.ts
import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { importDVI } from "@/lib/integrations/dvi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Test seam — swap these in unit tests to avoid real DB / auth calls. */
export const __deps = { getSession, getDb };

/**
 * Parse only the fields that cannot be derived from the session or URL.
 * shopId is intentionally NOT read from the request — it is always taken
 * from the session to prevent cross-tenant DVI imports.
 */
async function readInputs(req: NextRequest, vinParam: string) {
  const vin = vinParam?.toUpperCase();

  if (req.method === "POST") {
    // Try FormData first
    try {
      const fd = await req.formData();
      const customerId = String(fd.get("customerId") || "");
      if (vin) return { vin, customerId };
    } catch {}
    // Fallback to JSON body
    try {
      const j = await req.json();
      const customerId = j?.customerId ? String(j.customerId) : "";
      if (vin) return { vin, customerId };
    } catch {}
    if (vin) return { vin, customerId: "" };
    return { error: "Missing vin in URL." };
  }

  if (req.method === "GET") {
    const qp = req.nextUrl.searchParams;
    const customerId = String(qp.get("customerId") || "");
    if (vin) return { vin, customerId };
    return { error: "Missing vin in URL." };
  }

  return { error: "Method not allowed." };
}

export async function POST(req: NextRequest, ctx: { params: { vin: string } }) {
  return handle(req, ctx);
}
export async function GET(req: NextRequest, ctx: { params: { vin: string } }) {
  return handle(req, ctx);
}

async function handle(req: NextRequest, ctx: { params: { vin: string } }) {
  const session = await __deps.getSession();
  if (!session?.shopId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Always use the authenticated shop — never trust a caller-supplied shopId.
  const shopId = Number(session.shopId);

  try {
    const vinParam = ctx.params.vin;
    const parsed = await readInputs(req, vinParam);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { vin, customerId } = parsed;
    const db = await __deps.getDb();

    // Verify the VIN belongs to this shop before doing anything.
    // A caller who supplies a foreign VIN in the URL param gets a 404,
    // preventing them from reading RO numbers or triggering DVI imports
    // on vehicles owned by other tenants.
    const vehicle = await db.collection("vehicles").findOne(
      { vin, $or: [{ shopId: String(shopId) }, { shopId: shopId }] },
      { projection: { _id: 1 } }
    );
    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }

    // Most recent ticket for RO# — scoped to session shop
    const ticket = await db.collection("tickets").findOne(
      { shopId, vin },
      { sort: { updatedAt: -1 }, projection: { roNumber: 1 } }
    );
    const ro = ticket?.roNumber ? String(ticket.roNumber) : null;

    // Step 1: DVI import (if we have RO)
    let dviSummary: any = { skipped: true };
    if (ro) {
      try {
        const res = await importDVI({ shopId, roNumber: ro });
        dviSummary = { inserted: res.insertedCount };
      } catch (e: any) {
        dviSummary = { error: String(e?.message || e) };
      }
    }

    // -------- Fixed redirect: build absolute URL from req.url --------
    if (req.method === "POST") {
      const { origin } = new URL(req.url);
      const dest =
        `${origin}/dashboard?vin=` +
        `${encodeURIComponent(customerId)}/vehicles/${encodeURIComponent(vin)}?refreshed=1`;

      return NextResponse.redirect(dest, { status: 303 });
    }

    // For GET testing: return JSON
    return NextResponse.json({
      ok: true,
      vin,
      shopId,
      roNumber: ro,
      dvi: dviSummary,
    });
  } catch (err: any) {
    console.error("vehicle refresh error", err);
    const details = typeof err?.message === "string" ? err.message : undefined;
    return NextResponse.json({ error: "Server error", details }, { status: 500 });
  }
}
