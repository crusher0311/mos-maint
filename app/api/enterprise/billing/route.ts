import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { ObjectId } from "mongodb";
import { getViewedVinCount } from "@/lib/plan-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireEnterpriseAccess() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }
  if (!["owner", "admin"].includes(session.role || "")) {
    return { error: "Forbidden - admin access required", status: 403 };
  }
  
  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: Number(session.shopId) });
  
  if (!shop?.enterpriseId) {
    return { error: "Not part of an enterprise", status: 403 };
  }
  
  return { session, enterpriseId: shop.enterpriseId, db };
}

export async function GET() {
  const auth = await requireEnterpriseAccess();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { db, enterpriseId } = auth;

  try {
    const enterpriseIdStr = enterpriseId.toString();
    let enterpriseObjId: ObjectId | null = null;
    try {
      enterpriseObjId = new ObjectId(enterpriseIdStr);
    } catch (e) {
      // Not a valid ObjectId format
    }

    const enterprise = await db.collection("enterprise_accounts").findOne({ 
      _id: enterpriseObjId || enterpriseIdStr 
    });
    
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    // Query shops with both ObjectId and string to handle mixed storage
    const shops = await db.collection("shops").find({
      $or: [
        ...(enterpriseObjId ? [{ enterpriseId: enterpriseObjId }] : []),
        { enterpriseId: enterpriseIdStr }
      ]
    }).toArray();

    const locationBilling = await Promise.all(shops.map(async (shop) => {
      const billing = shop.billing || {};
      const isPaid = billing.plan === "professional" || billing.plan === "enterprise" || 
                     billing.plan === "starter" || billing.plan === "plus" || billing.plan === "elite" ||
                     billing.plan === "appfueled_invoice";
      
      let vehicleCount = 0;
      if (isPaid) {
        vehicleCount = await db.collection("vehicles").countDocuments({ 
          shopId: String(shop.shopId),
          "status.active": true,
        });
      } else {
        vehicleCount = await getViewedVinCount(db, shop.shopId);
      }

      return {
        shopId: shop.shopId || shop.id,
        name: shop.name,
        locationIdentifier: shop.locationIdentifier || null,
        plan: billing.plan || shop.plan || "trial",
        planDisplay: (billing.plan || shop.plan) ? ((billing.plan || shop.plan).charAt(0).toUpperCase() + (billing.plan || shop.plan).slice(1)) : "Free Trial",
        status: billing.status || "trial",
        vehicleCount,
        nextBillingDate: billing.nextBillingDate || null,
        stripeCustomerId: shop.stripeCustomerId || null,
        stripeSubscriptionId: billing.stripeSubscriptionId || shop.stripeSubscriptionId || null,
        enabledFeatures: shop.enabledFeatures || [],
      };
    }));

    const totalVehicles = locationBilling.reduce((sum, loc) => sum + loc.vehicleCount, 0);
    const activeLocations = locationBilling.filter(loc => loc.status === "active" || loc.status === "trial").length;
    
    const hasEnterpriseBilling = enterprise.billing?.enabled === true;
    const enterprisePlan = enterprise.billing?.plan || null;
    const enterpriseStatus = enterprise.billing?.status || null;

    return NextResponse.json({
      enterprise: {
        id: enterprise._id.toString(),
        name: enterprise.name,
        hasEnterpriseBilling,
        plan: enterprisePlan,
        status: enterpriseStatus,
        stripeCustomerId: enterprise.billing?.stripeCustomerId || null,
        nextBillingDate: enterprise.billing?.nextBillingDate || null,
      },
      summary: {
        totalLocations: shops.length,
        activeLocations,
        totalVehicles,
      },
      locations: locationBilling,
    });
  } catch (err: any) {
    console.error("Error fetching enterprise billing:", err);
    return NextResponse.json({ error: "Failed to fetch billing data" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireEnterpriseAccess();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { db, enterpriseId } = auth;

  try {
    const body = await req.json();
    const { action } = body;

    const enterpriseIdStr = enterpriseId.toString();
    let enterpriseObjId: ObjectId | null = null;
    try {
      enterpriseObjId = new ObjectId(enterpriseIdStr);
    } catch (e) {
      // Not a valid ObjectId format
    }

    const filter = enterpriseObjId ? { _id: enterpriseObjId } : { _id: enterpriseIdStr };

    if (action === "enable_enterprise_billing") {
      await db.collection("enterprise_accounts").updateOne(
        filter,
        { 
          $set: { 
            "billing.enabled": true,
            "billing.enabledAt": new Date(),
            updatedAt: new Date() 
          } 
        }
      );
      return NextResponse.json({ ok: true, message: "Enterprise billing enabled" });
    }

    if (action === "disable_enterprise_billing") {
      await db.collection("enterprise_accounts").updateOne(
        filter,
        { 
          $set: { 
            "billing.enabled": false,
            updatedAt: new Date() 
          } 
        }
      );
      return NextResponse.json({ ok: true, message: "Enterprise billing disabled" });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    console.error("Error updating enterprise billing:", err);
    return NextResponse.json({ error: "Failed to update billing" }, { status: 500 });
  }
}
