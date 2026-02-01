import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";

export async function GET(req: Request) {
  const authHeader = req.headers.get("x-internal-secret");
  if (authHeader !== INTERNAL_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const shops = await sql`
      SELECT shop_id, name, settings FROM shops 
      WHERE settings->'protractor'->>'configured' = 'true'
         OR settings->'protractor'->>'apiKey' IS NOT NULL
         OR settings->'tekmetric'->>'configured' = 'true'
         OR settings->'tekmetric'->>'shopId' IS NOT NULL
    `;

    const formattedShops = shops.map((shop: any) => ({
      shopId: shop.shop_id,
      name: shop.name,
      protractor: {
        configured: shop.settings?.protractor?.configured,
        apiKey: shop.settings?.protractor?.apiKey,
      },
      tekmetric: {
        configured: shop.settings?.tekmetric?.configured,
        shopId: shop.settings?.tekmetric?.shopId,
      }
    }));

    return NextResponse.json({ shops: formattedShops });
  } catch (error: any) {
    console.error("[InternalAPI] Error fetching shops:", error.message);
    return NextResponse.json({ error: "Failed to fetch shops" }, { status: 500 });
  }
}
