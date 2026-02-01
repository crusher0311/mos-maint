// app/api/vehicles/[vin]/refresh/route.ts
import { NextResponse, NextRequest } from "next/server";
import { sql } from "@/lib/db/postgres";
import { importDVI } from "@/lib/integrations/dvi";
import { getShopByShopId } from "@/lib/db/shops-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readInputs(req: NextRequest, vinParam: string) {
  const vin = vinParam?.toUpperCase();

  if (req.method === "POST") {
    // Try FormData first
    try {
      const fd = await req.formData();
      const shopId = Number(fd.get("shopId"));
      const customerId = String(fd.get("customerId") || "");
      if (vin && Number.isFinite(shopId) && customerId) {
        return { vin, shopId, customerId };
      }
    } catch {}
    // Fallback to JSON body
    try {
      const j = await req.json();
      const shopId = Number(j?.shopId);
      const customerId = j?.customerId ? String(j.customerId) : "";
      if (vin && Number.isFinite(shopId) && customerId) {
        return { vin, shopId, customerId };
      }
    } catch {}
    return { error: "Missing vin/shopId/customerId in POST body." };
  }

  if (req.method === "GET") {
    const qp = req.nextUrl.searchParams;
    const shopId = Number(qp.get("shopId"));
    const customerId = String(qp.get("customerId") || "");
    if (vin && Number.isFinite(shopId) && customerId) {
      return { vin, shopId, customerId };
    }
    return { error: "For GET testing, pass ?shopId=###&customerId=XXXX" };
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
  try {
    const vinParam = ctx.params.vin;
    const parsed = await readInputs(req, vinParam);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { vin, shopId, customerId } = parsed;
    const now = new Date();

    // Get shop UUID
    const shop = await getShopByShopId(shopId);
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    // Most recent work order for RO#
    const ticketRows = await sql`
      SELECT work_order_number FROM work_orders
      WHERE shop_id = ${shop.id} AND vin = ${vin.toUpperCase()}
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `;
    const ro = ticketRows.length > 0 && ticketRows[0].work_order_number 
      ? String(ticketRows[0].work_order_number) 
      : null;

    // Log job start
    await sql`
      INSERT INTO jobs (type, shop_id, vin, customer_id, status, started_at, updated_at)
      VALUES ('vehicle-refresh', ${shop.id}, ${vin}, ${customerId}, 'running', ${now}, ${now})
    `;

    // Step 1: DVI import (if we have RO)
    let dviSummary: any = { skipped: true };
    if (ro) {
      try {
        const res = await importDVI({ shopId, roNumber: ro });
        dviSummary = { inserted: res.insertedCount };
      } catch (e: any) {
        dviSummary = { error: String(e?.message || e) };
        await sql`
          INSERT INTO jobs (type, shop_id, vin, customer_id, stage, error, created_at)
          VALUES ('vehicle-refresh-error', ${shop.id}, ${vin}, ${customerId}, 'dvi', ${dviSummary.error}, NOW())
        `;
      }
    } else {
      await sql`
        INSERT INTO jobs (type, shop_id, vin, customer_id, note, created_at)
        VALUES ('vehicle-refresh-note', ${shop.id}, ${vin}, ${customerId}, 'No RO# found for VIN; skipped DVI.', NOW())
      `;
    }

    await sql`
      UPDATE jobs 
      SET status = 'done', updated_at = NOW()
      WHERE type = 'vehicle-refresh' 
        AND shop_id = ${shop.id} 
        AND vin = ${vin} 
        AND customer_id = ${customerId} 
        AND status = 'running'
    `;

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
