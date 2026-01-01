import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";
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
    const db = await getDb();
    
    let enterprise;
    try {
      enterprise = await db.collection("enterprise_accounts").findOne({ 
        _id: new ObjectId(enterpriseId) 
      });
    } catch {
      return NextResponse.json({ error: "Invalid enterprise ID" }, { status: 400 });
    }
    
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const shops = await db.collection("shops")
      .find({ shopId: { $in: enterprise.shopIds || [] } })
      .project({ shopId: 1, name: 1, locationIdentifier: 1 })
      .toArray();

    return NextResponse.json({
      ok: true,
      enterprise: {
        _id: enterprise._id,
        name: enterprise.name,
        shopIds: enterprise.shopIds,
        shops,
        featureSettings: enterprise.featureSettings || {},
        createdAt: enterprise.createdAt,
      },
    });
  } catch (err: any) {
    console.error("Enterprise get error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
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

    const db = await getDb();
    const enterprise = await db.collection("enterprise_accounts").findOne({ 
      _id: new ObjectId(enterpriseId) 
    });

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    if (action === "add_shop" && shopId) {
      await db.collection("enterprise_accounts").updateOne(
        { _id: new ObjectId(enterpriseId) },
        { $addToSet: { shopIds: shopId }, $set: { updatedAt: new Date() } }
      );

      await db.collection("shops").updateOne(
        { shopId },
        { $set: { enterpriseId: new ObjectId(enterpriseId), updatedAt: new Date() } }
      );

      await db.collection("audit_logs").insertOne({
        type: "enterprise_shop_added",
        enterpriseId: new ObjectId(enterpriseId),
        enterpriseName: enterprise.name,
        shopId,
        adminEmail: session.email,
        createdAt: new Date(),
      });

      return NextResponse.json({ ok: true, message: "Shop added to enterprise" });
    }

    if (action === "remove_shop" && shopId) {
      await db.collection("enterprise_accounts").updateOne(
        { _id: new ObjectId(enterpriseId) },
        { $pull: { shopIds: shopId }, $set: { updatedAt: new Date() } }
      );

      await db.collection("shops").updateOne(
        { shopId },
        { $unset: { enterpriseId: "" }, $set: { updatedAt: new Date() } }
      );

      await db.collection("audit_logs").insertOne({
        type: "enterprise_shop_removed",
        enterpriseId: new ObjectId(enterpriseId),
        enterpriseName: enterprise.name,
        shopId,
        adminEmail: session.email,
        createdAt: new Date(),
      });

      return NextResponse.json({ ok: true, message: "Shop removed from enterprise" });
    }

    if (action === "rename" && body.name) {
      const newName = body.name;
      if (newName?.trim()) {
        await db.collection("enterprise_accounts").updateOne(
          { _id: new ObjectId(enterpriseId) },
          { $set: { name: newName.trim(), updatedAt: new Date() } }
        );
        return NextResponse.json({ ok: true, message: "Enterprise renamed" });
      }
    }

    if (features) {
      const featureUpdate: Partial<FeatureSettings> = {};
      const validFeatures = ["maintenance", "job_lookup", "oil_sticker", "part_xref", "dvi_tracking"];
      
      for (const key of validFeatures) {
        if (features[key] !== undefined) {
          featureUpdate[key as keyof FeatureSettings] = features[key];
        }
      }
      
      await updateEnterpriseFeatures(enterpriseId, featureUpdate);
      
      await db.collection("audit_logs").insertOne({
        type: "enterprise_features_updated",
        enterpriseId: new ObjectId(enterpriseId),
        enterpriseName: enterprise.name,
        changes: featureUpdate,
        adminEmail: session.email,
        createdAt: new Date(),
      });

      const updatedEnterprise = await db.collection("enterprise_accounts").findOne({ 
        _id: new ObjectId(enterpriseId) 
      });

      return NextResponse.json({
        ok: true,
        message: "Enterprise features updated",
        enterprise: {
          _id: updatedEnterprise?._id,
          name: updatedEnterprise?.name,
          featureSettings: updatedEnterprise?.featureSettings || {},
        },
      });
    }

    return NextResponse.json({ error: "Invalid action or no changes provided" }, { status: 400 });
  } catch (err: any) {
    console.error("Enterprise action error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
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
    const db = await getDb();

    const enterprise = await db.collection("enterprise_accounts").findOne({
      _id: new ObjectId(enterpriseId)
    });

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    await db.collection("shops").updateMany(
      { enterpriseId: new ObjectId(enterpriseId) },
      { $unset: { enterpriseId: "" }, $set: { updatedAt: new Date() } }
    );

    await db.collection("enterprise_accounts").deleteOne({
      _id: new ObjectId(enterpriseId)
    });

    await db.collection("audit_logs").insertOne({
      type: "enterprise_deleted",
      enterpriseId: new ObjectId(enterpriseId),
      enterpriseName: enterprise.name,
      adminEmail: session.email,
      createdAt: new Date(),
    });

    return NextResponse.json({ ok: true, message: "Enterprise deleted" });
  } catch (err: any) {
    console.error("Delete enterprise error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
