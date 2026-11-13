import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { findShopByShopId } from "@/lib/data/repositories/shops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Validates the dedicated agent credential without polling/claiming a print.
export const GET = createExternalEndpoint("print:agent", async (_req: NextRequest, { shopId, isPartner }) => {
  if (isPartner || !Number.isSafeInteger(shopId) || shopId <= 0)
    return NextResponse.json({ error: "A shop-specific print agent key is required" }, { status: 403 });
  const shop = await findShopByShopId(shopId);
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  return NextResponse.json({ shopId, name: String(shop.name || `Shop ${shopId}`) },
    { headers: { "Cache-Control": "no-store" } });
});
