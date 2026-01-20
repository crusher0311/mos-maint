import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
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

    const shopId = isNaN(Number(params.shopId)) ? params.shopId : Number(params.shopId);
    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });
    
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const vinViewCount = await db.collection("viewed_vins").countDocuments({ shopId });

    return NextResponse.json({
      ok: true,
      shop: {
        shopId: shop.shopId,
        name: shop.name,
        locationIdentifier: shop.locationIdentifier,
        enterpriseId: shop.enterpriseId,
        billing: {
          plan: shop.billing?.plan || "trial",
          status: shop.billing?.status || "trial",
          vinLimit: shop.trialVinLimit || 10,
          vinViewCount,
        },
        enabledFeatures: shop.enabledFeatures || {},
        createdAt: shop.createdAt,
        isLocked: shop.isLocked || false,
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

    const shopId = isNaN(Number(params.shopId)) ? params.shopId : Number(params.shopId);
    const body = await req.json();
    const { action, billing, features } = body;

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    if (action === "lock") {
      await db.collection("shops").updateOne(
        { shopId },
        { $set: { isLocked: true, lockedAt: new Date(), lockedBy: session.email } }
      );
      await db.collection("audit_logs").insertOne({
        type: "shop_locked",
        shopId,
        shopName: shop.name,
        adminEmail: session.email,
        createdAt: new Date(),
      });
      return NextResponse.json({ ok: true, message: "Shop locked" });
    }

    if (action === "unlock") {
      await db.collection("shops").updateOne(
        { shopId },
        { $unset: { isLocked: "", lockedAt: "", lockedBy: "" } }
      );
      await db.collection("audit_logs").insertOne({
        type: "shop_unlocked",
        shopId,
        shopName: shop.name,
        adminEmail: session.email,
        createdAt: new Date(),
      });
      return NextResponse.json({ ok: true, message: "Shop unlocked" });
    }

    if (billing) {
      const billingUpdate: any = {};
      if (billing.plan !== undefined) billingUpdate.plan = billing.plan as BillingPlan;
      if (billing.status !== undefined) billingUpdate.status = billing.status as BillingStatus;
      if (billing.vinLimit !== undefined) billingUpdate.vinLimit = billing.vinLimit;
      
      await updateShopBilling(shopId as number, billingUpdate);
      
      await db.collection("audit_logs").insertOne({
        type: "shop_billing_updated",
        shopId,
        shopName: shop.name,
        changes: billingUpdate,
        adminEmail: session.email,
        createdAt: new Date(),
      });
    }

    if (features) {
      const featureUpdate: Partial<FeatureSettings> = {};
      const validFeatures = ["maintenance", "job_lookup", "oil_sticker", "part_xref", "keytags", "dvi_tracking"];
      
      for (const key of validFeatures) {
        if (features[key] !== undefined) {
          featureUpdate[key as keyof FeatureSettings] = features[key];
        }
      }
      
      await updateShopFeatures(shopId as number, featureUpdate);
      
      await db.collection("audit_logs").insertOne({
        type: "shop_features_updated",
        shopId,
        shopName: shop.name,
        changes: featureUpdate,
        adminEmail: session.email,
        createdAt: new Date(),
      });
    }

    if (billing || features) {
      const updatedShop = await db.collection("shops").findOne({ shopId });
      return NextResponse.json({
        ok: true,
        shop: {
          shopId: updatedShop?.shopId,
          name: updatedShop?.name,
          billing: {
            plan: updatedShop?.billing?.plan || "trial",
            status: updatedShop?.billing?.status || "trial",
            vinLimit: updatedShop?.trialVinLimit || 10,
          },
          enabledFeatures: updatedShop?.enabledFeatures || {},
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

    const shopId = isNaN(Number(params.shopId)) ? params.shopId : Number(params.shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    await db.collection("shops").deleteOne({ shopId });
    await db.collection("users").deleteMany({ shopId });
    await db.collection("sessions").deleteMany({ shopId });

    await db.collection("audit_logs").insertOne({
      type: "shop_deleted",
      shopId,
      shopName: shop.name,
      adminEmail: session.email,
      createdAt: new Date(),
    });

    return NextResponse.json({ ok: true, message: "Shop deleted permanently" });
  } catch (err) {
    console.error("Shop delete error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
