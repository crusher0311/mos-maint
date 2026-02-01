import { NextResponse, NextRequest } from "next/server";
import sql from "@/lib/db/postgres";
import {
  fetchVehicleById,
  fetchWorkOrderById,
  upsertProtractorVehicleSnapshot,
  upsertProtractorWorkOrderSnapshot,
} from "@/lib/integrations/protractor";
import { attributeRevenueFromWorkOrder } from "@/lib/enterprise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function findShopByToken(token: string) {
  const rows = await sql`
    SELECT shop_id, name FROM shops WHERE protractor_webhook_token = ${token}
  `;
  return rows[0] as any;
}

function resolveVin(payload: any): string | null {
  const vin =
    payload?.VIN ??
    payload?.vin ??
    payload?.ServiceItem?.VIN ??
    payload?.serviceItem?.vin ??
    null;
  return vin ? String(vin).trim().toUpperCase() : null;
}

export async function GET(req: NextRequest, ctx: { params: { token: string } }) {
  const token = ctx.params?.token || "";
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const isPing = req.nextUrl.searchParams.has("ping");
  const shop = await findShopByToken(token);
  if (!shop) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  if (isPing) {
    return NextResponse.json({ ok: true, shopId: shop.shop_id, tokenValid: true });
  }
  return NextResponse.json({ ok: true, shopId: shop.shop_id });
}

export async function POST(req: NextRequest, ctx: { params: { token: string } }) {
  const token = ctx.params?.token || "";
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const shop = await findShopByToken(token);
  if (!shop) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  const raw = await req.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  const connectionId = req.nextUrl.searchParams.get("connectionId") ?? null;
  const apiKey = req.nextUrl.searchParams.get("apiKey") ?? null;
  const objectType = req.nextUrl.searchParams.get("type") ?? null;
  const objectId = req.nextUrl.searchParams.get("id") ?? null;
  const operation = req.nextUrl.searchParams.get("operation") ?? null;

  await sql`
    INSERT INTO events (provider, shop_id, token, connection_id, api_key, object_type, object_id, operation, payload, raw, received_at)
    VALUES ('protractor', ${shop.shop_id}, ${token}, ${connectionId}, ${apiKey ? `${apiKey.slice(0, 8)}...` : null}, ${objectType}, ${objectId}, ${operation}, ${payload ? JSON.stringify(payload) : null}::jsonb, ${raw}, NOW())
  `;

  try {
    const shopId = Number(shop.shop_id);

    if (objectType === "ServiceItem" && objectId && operation === "Update") {
      const result = await fetchVehicleById(shopId, objectId);
      if (result.ok && result.vehicle?.VIN) {
        await upsertProtractorVehicleSnapshot(shopId, result.vehicle.VIN, result.vehicle);
        console.log(`[Protractor Webhook] Updated vehicle snapshot for ${result.vehicle.VIN}`);
      }
    }

    if (objectType === "WorkOrder" && objectId) {
      const result = await fetchWorkOrderById(shopId, objectId);
      if (result.ok && result.workOrder) {
        await upsertProtractorWorkOrderSnapshot(shopId, result.workOrder);
        console.log(`[Protractor Webhook] Updated work order snapshot ${objectId}`);
        
        if (result.workOrder.Completed) {
          const vin = result.workOrder.ServiceItem?.VIN?.toUpperCase();
          if (vin) {
            const savedRows = await sql`
              SELECT * FROM protractor_work_orders WHERE shop_id = ${String(shopId)} AND work_order_id = ${objectId}
            `;
            const savedWO = savedRows[0] as any;
            
            if (savedWO?.package_summaries?.length > 0) {
              const attribution = await attributeRevenueFromWorkOrder(
                shopId,
                objectId,
                vin,
                savedWO.package_summaries,
                "protractor"
              );
              if (attribution.matched > 0) {
                console.log(`[Protractor Webhook] Revenue attribution: ${attribution.matched} jobs, $${attribution.revenue.toFixed(2)}`);
              }
            }
          }
        }
      }
    }

    if (objectType === "Contact" && objectId && operation === "Update") {
      console.log(`[Protractor Webhook] Contact ${objectId} updated`);
    }

  } catch (err: any) {
    console.error("[Protractor Webhook] Processing error:", err.message);
  }

  return NextResponse.json({ ok: true, received: new Date().toISOString() });
}
