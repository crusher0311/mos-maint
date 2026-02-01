import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { 
  updateEnterpriseFeatures,
  type FeatureSettings
} from "@/lib/featureResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { enterpriseId: string } }
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const enterpriseId = params.enterpriseId;
    
    const enterprises = await sql`
      SELECT id, name, shop_ids as "shopIds", feature_settings as "featureSettings", created_at as "createdAt"
      FROM enterprise_accounts
      WHERE id = ${enterpriseId}
      LIMIT 1
    `;
    
    if (enterprises.length === 0) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }
    
    const enterprise = enterprises[0];
    const shopIds = enterprise.shopIds || [];

    let shops: Record<string, unknown>[] = [];
    if (shopIds.length > 0) {
      shops = await sql`
        SELECT shop_id as "shopId", name, location_identifier as "locationIdentifier"
        FROM shops
        WHERE shop_id = ANY(${shopIds.map(String)})
      `;
    }

    return NextResponse.json({
      ok: true,
      enterprise: {
        _id: enterprise.id,
        name: enterprise.name,
        shopIds: enterprise.shopIds,
        shops,
        featureSettings: enterprise.featureSettings || {},
        createdAt: enterprise.createdAt,
      },
    });
  } catch (err: unknown) {
    console.error("Enterprise get error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { enterpriseId: string } }
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { action, shopId, features } = body;
    const enterpriseId = params.enterpriseId;

    const enterprises = await sql`
      SELECT id, name, shop_ids as "shopIds", feature_settings as "featureSettings"
      FROM enterprise_accounts
      WHERE id = ${enterpriseId}
      LIMIT 1
    `;

    if (enterprises.length === 0) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }
    
    const enterprise = enterprises[0];

    if (action === "add_shop" && shopId) {
      const currentShopIds = enterprise.shopIds || [];
      const updatedShopIds = [...new Set([...currentShopIds, shopId])];
      
      await sql`
        UPDATE enterprise_accounts
        SET shop_ids = ${updatedShopIds}, updated_at = NOW()
        WHERE id = ${enterpriseId}
      `;

      await sql`
        UPDATE shops
        SET enterprise_id = ${enterpriseId}, updated_at = NOW()
        WHERE shop_id = ${String(shopId)}
      `;

      await sql`
        INSERT INTO audit_logs (type, enterprise_id, enterprise_name, shop_id, admin_email, created_at)
        VALUES ('enterprise_shop_added', ${enterpriseId}, ${enterprise.name}, ${String(shopId)}, ${session.email}, NOW())
      `;

      return NextResponse.json({ ok: true, message: "Shop added to enterprise" });
    }

    if (action === "remove_shop" && shopId) {
      const currentShopIds = enterprise.shopIds || [];
      const updatedShopIds = currentShopIds.filter((id: string) => String(id) !== String(shopId));
      
      await sql`
        UPDATE enterprise_accounts
        SET shop_ids = ${updatedShopIds}, updated_at = NOW()
        WHERE id = ${enterpriseId}
      `;

      await sql`
        UPDATE shops
        SET enterprise_id = NULL, updated_at = NOW()
        WHERE shop_id = ${String(shopId)}
      `;

      await sql`
        INSERT INTO audit_logs (type, enterprise_id, enterprise_name, shop_id, admin_email, created_at)
        VALUES ('enterprise_shop_removed', ${enterpriseId}, ${enterprise.name}, ${String(shopId)}, ${session.email}, NOW())
      `;

      return NextResponse.json({ ok: true, message: "Shop removed from enterprise" });
    }

    if (action === "rename" && body.name) {
      const newName = body.name;
      if (newName?.trim()) {
        await sql`
          UPDATE enterprise_accounts
          SET name = ${newName.trim()}, updated_at = NOW()
          WHERE id = ${enterpriseId}
        `;
        return NextResponse.json({ ok: true, message: "Enterprise renamed" });
      }
    }

    if (features) {
      const featureUpdate: Partial<FeatureSettings> = {};
      const validFeatures = ["maintenance", "job_lookup", "common_failures", "oil_sticker", "keytags", "auto_booking", "part_xref"];
      
      for (const key of validFeatures) {
        if (features[key] !== undefined) {
          featureUpdate[key as keyof FeatureSettings] = features[key];
        }
      }
      
      await updateEnterpriseFeatures(enterpriseId, featureUpdate);
      
      await sql`
        INSERT INTO audit_logs (type, enterprise_id, enterprise_name, changes, admin_email, created_at)
        VALUES ('enterprise_features_updated', ${enterpriseId}, ${enterprise.name}, ${JSON.stringify(featureUpdate)}, ${session.email}, NOW())
      `;

      const updatedEnterprise = await sql`
        SELECT id, name, feature_settings as "featureSettings"
        FROM enterprise_accounts
        WHERE id = ${enterpriseId}
        LIMIT 1
      `;

      return NextResponse.json({
        ok: true,
        message: "Enterprise features updated",
        enterprise: {
          _id: updatedEnterprise[0]?.id,
          name: updatedEnterprise[0]?.name,
          featureSettings: updatedEnterprise[0]?.featureSettings || {},
        },
      });
    }

    return NextResponse.json({ error: "Invalid action or no changes provided" }, { status: 400 });
  } catch (err: unknown) {
    console.error("Enterprise action error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { enterpriseId: string } }
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const enterpriseId = params.enterpriseId;

    const enterprises = await sql`
      SELECT id, name FROM enterprise_accounts WHERE id = ${enterpriseId} LIMIT 1
    `;

    if (enterprises.length === 0) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }
    
    const enterprise = enterprises[0];

    await sql`
      UPDATE shops
      SET enterprise_id = NULL, updated_at = NOW()
      WHERE enterprise_id = ${enterpriseId}
    `;

    await sql`
      DELETE FROM enterprise_accounts WHERE id = ${enterpriseId}
    `;

    await sql`
      INSERT INTO audit_logs (type, enterprise_id, enterprise_name, admin_email, created_at)
      VALUES ('enterprise_deleted', ${enterpriseId}, ${enterprise.name}, ${session.email}, NOW())
    `;

    return NextResponse.json({ ok: true, message: "Enterprise deleted" });
  } catch (err: unknown) {
    console.error("Delete enterprise error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
