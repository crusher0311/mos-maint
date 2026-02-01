import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { 
  updateShopFeatures, 
  updateShopBilling,
  type FeatureSettings,
  type BillingPlan,
  type BillingStatus
} from "@/lib/featureResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopIdParam = params.shopId;
    const shopResult = await sql`
      SELECT * FROM shops WHERE shop_id = ${shopIdParam} LIMIT 1
    `;
    const shop = shopResult[0];
    
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const vinViewResult = await sql<{count: string}[]>`
      SELECT COUNT(*) as count FROM viewed_vins WHERE shop_id = ${shopIdParam}
    `;
    const vinViewCount = parseInt(vinViewResult[0]?.count || "0", 10);

    const billing = shop.billing as Record<string, unknown> | null;
    const settings = shop.settings as Record<string, unknown> | null;
    const enabledFeatures = shop.enabled_features as Record<string, boolean> | null;

    return NextResponse.json({
      ok: true,
      shop: {
        shopId: shop.shop_id ? parseInt(shop.shop_id, 10) : null,
        name: shop.name,
        locationIdentifier: shop.location_identifier,
        enterpriseId: shop.enterprise_id,
        billing: {
          plan: (billing?.plan as string) || "trial",
          status: (billing?.status as string) || "trial",
          vinLimit: (settings?.trialVinLimit as number) || 10,
          vinViewCount,
        },
        enabledFeatures: enabledFeatures || {},
        createdAt: shop.created_at,
        isLocked: shop.is_locked || false,
      },
    });
  } catch (err) {
    console.error("Shop get error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopIdParam = params.shopId;
    const shopId = isNaN(Number(shopIdParam)) ? shopIdParam : Number(shopIdParam);
    const body = await req.json();
    const { action, billing, features } = body;

    const shopResult = await sql`
      SELECT * FROM shops WHERE shop_id = ${String(shopIdParam)} LIMIT 1
    `;
    const shop = shopResult[0];

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const now = new Date();

    if (action === "lock") {
      await sql`
        UPDATE shops 
        SET is_locked = true, locked_at = ${now}, locked_by = ${session.email}, updated_at = ${now}
        WHERE shop_id = ${String(shopIdParam)}
      `;
      await sql`
        INSERT INTO audit_logs (type, shop_id, metadata, admin_email, created_at)
        VALUES ('shop_locked', ${shop.id}, ${JSON.stringify({ shopName: shop.name })}::jsonb, ${session.email}, ${now})
      `;
      return NextResponse.json({ ok: true, message: "Shop locked" });
    }

    if (action === "unlock") {
      await sql`
        UPDATE shops 
        SET is_locked = false, locked_at = NULL, locked_by = NULL, updated_at = ${now}
        WHERE shop_id = ${String(shopIdParam)}
      `;
      await sql`
        INSERT INTO audit_logs (type, shop_id, metadata, admin_email, created_at)
        VALUES ('shop_unlocked', ${shop.id}, ${JSON.stringify({ shopName: shop.name })}::jsonb, ${session.email}, ${now})
      `;
      return NextResponse.json({ ok: true, message: "Shop unlocked" });
    }

    if (billing) {
      const billingUpdate: Record<string, unknown> = {};
      if (billing.plan !== undefined) billingUpdate.plan = billing.plan as BillingPlan;
      if (billing.status !== undefined) billingUpdate.status = billing.status as BillingStatus;
      if (billing.vinLimit !== undefined) billingUpdate.vinLimit = billing.vinLimit;
      
      await updateShopBilling(shopId as number, billingUpdate as Parameters<typeof updateShopBilling>[1]);
      
      await sql`
        INSERT INTO audit_logs (type, shop_id, metadata, admin_email, created_at)
        VALUES ('shop_billing_updated', ${shop.id}, ${JSON.stringify({ shopName: shop.name, changes: billingUpdate })}::jsonb, ${session.email}, ${now})
      `;
    }

    if (features) {
      const featureUpdate: Partial<FeatureSettings> = {};
      const validFeatures = ["maintenance", "job_lookup", "common_failures", "oil_sticker", "keytags", "auto_booking", "part_xref"];
      
      for (const key of validFeatures) {
        if (features[key] !== undefined) {
          featureUpdate[key as keyof FeatureSettings] = features[key];
        }
      }
      
      await updateShopFeatures(shopId as number, featureUpdate);
      
      await sql`
        INSERT INTO audit_logs (type, shop_id, metadata, admin_email, created_at)
        VALUES ('shop_features_updated', ${shop.id}, ${JSON.stringify({ shopName: shop.name, changes: featureUpdate })}::jsonb, ${session.email}, ${now})
      `;
    }

    if (billing || features) {
      const updatedShopResult = await sql`
        SELECT * FROM shops WHERE shop_id = ${String(shopIdParam)} LIMIT 1
      `;
      const updatedShop = updatedShopResult[0];
      const updatedBilling = updatedShop?.billing as Record<string, unknown> | null;
      const updatedSettings = updatedShop?.settings as Record<string, unknown> | null;
      const updatedFeatures = updatedShop?.enabled_features as Record<string, boolean> | null;
      
      return NextResponse.json({
        ok: true,
        shop: {
          shopId: updatedShop?.shop_id ? parseInt(updatedShop.shop_id, 10) : null,
          name: updatedShop?.name,
          billing: {
            plan: (updatedBilling?.plan as string) || "trial",
            status: (updatedBilling?.status as string) || "trial",
            vinLimit: (updatedSettings?.trialVinLimit as number) || 10,
          },
          enabledFeatures: updatedFeatures || {},
        },
      });
    }

    return NextResponse.json({ error: "Invalid action or no changes provided" }, { status: 400 });
  } catch (err) {
    console.error("Shop action error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopIdParam = params.shopId;

    const shopResult = await sql`
      SELECT * FROM shops WHERE shop_id = ${shopIdParam} LIMIT 1
    `;
    const shop = shopResult[0];

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const now = new Date();

    await sql`DELETE FROM shops WHERE shop_id = ${shopIdParam}`;
    await sql`DELETE FROM users WHERE shop_id = ${shopIdParam}`;
    await sql`DELETE FROM sessions WHERE shop_id = ${shopIdParam}`;

    await sql`
      INSERT INTO audit_logs (type, metadata, admin_email, created_at)
      VALUES ('shop_deleted', ${JSON.stringify({ shopId: shopIdParam, shopName: shop.name })}::jsonb, ${session.email}, ${now})
    `;

    return NextResponse.json({ ok: true, message: "Shop deleted permanently" });
  } catch (err) {
    console.error("Shop delete error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
