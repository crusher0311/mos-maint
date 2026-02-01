import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  const shopId = params.shopId;
  if (!shopId || isNaN(Number(shopId))) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  try {
    const { action, value } = await req.json();

    if (action === "setLimit") {
      const limit = Number(value);
      if (isNaN(limit) || limit < 0) {
        return NextResponse.json({ error: "Invalid limit value" }, { status: 400 });
      }

      const currentShop = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
      console.log(`[VIN Limit] Shop ${shopId} current state:`, JSON.stringify({
        found: currentShop.length > 0,
        billingVinLimit: (currentShop[0] as any)?.billing?.vinLimit,
        trialVinLimit: (currentShop[0] as any)?.trial_vin_limit,
        newLimit: limit
      }));

      const result = await sql`
        UPDATE shops SET 
          billing = COALESCE(billing, '{}'::jsonb) || jsonb_build_object('vinLimit', ${limit}),
          trial_vin_limit = ${limit}
        WHERE shop_id = ${shopId}
        RETURNING id
      `;

      console.log(`[VIN Limit] Set limit for shopId ${shopId}: updated=${result.length}`);

      if (result.length === 0) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }

      return NextResponse.json({ ok: true, message: `VIN limit set to ${limit}` });
    }

    if (action === "resetLimit") {
      const result = await sql`
        UPDATE shops SET 
          billing = billing - 'vinLimit',
          trial_vin_limit = NULL
        WHERE shop_id = ${shopId}
        RETURNING id
      `;

      if (result.length === 0) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }

      return NextResponse.json({ ok: true, message: "VIN limit reset to default" });
    }

    if (action === "resetViews") {
      const result = await sql`
        DELETE FROM viewed_vins WHERE shop_id = ${shopId}
      `;

      return NextResponse.json({ 
        ok: true, 
        message: `Reset viewed VINs for shop ${shopId}` 
      });
    }

    if (action === "addViews") {
      const addAmount = Number(value);
      if (isNaN(addAmount) || addAmount <= 0) {
        return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
      }

      const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
      const shop = shopRows[0] as any;
      if (!shop) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }
      
      const platformRows = await sql`SELECT * FROM platform_settings WHERE key = 'trial'`;
      const platformSettings = platformRows[0] as any;
      const defaultLimit = platformSettings?.vin_limit ?? 10;
      const currentLimit = shop?.billing?.vinLimit ?? shop?.trial_vin_limit ?? defaultLimit;

      const newLimit = currentLimit + addAmount;
      await sql`
        UPDATE shops SET 
          billing = COALESCE(billing, '{}'::jsonb) || jsonb_build_object('vinLimit', ${newLimit}),
          trial_vin_limit = ${newLimit}
        WHERE shop_id = ${shopId}
      `;

      return NextResponse.json({ 
        ok: true, 
        message: `Added ${addAmount} VINs (new limit: ${newLimit})` 
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  } catch (err: any) {
    console.error("Shop VIN management error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
