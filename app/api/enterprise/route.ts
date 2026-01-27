import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { createEnterprise, getEnterpriseById, addShopToEnterprise, removeShopFromEnterprise } from "@/lib/enterprise";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdminAuth() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }
  if (!["owner", "admin"].includes(session.role || "")) {
    return { error: "Forbidden - admin access required", status: 403 };
  }
  return { session };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const { searchParams } = new URL(req.url);
    const enterpriseId = searchParams.get("id");
    
    if (enterpriseId) {
      const enterprise = await getEnterpriseById(enterpriseId);
      if (!enterprise) {
        return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
      }
      
      const db = await getDb();
      const availableUsers = await db.collection("users")
        .find({ shopId: { $in: enterprise.shopIds } })
        .project({ email: 1, name: 1, role: 1 })
        .toArray();
      
      const uniqueUsers = new Map();
      availableUsers.forEach((u: any) => {
        if (!uniqueUsers.has(u.email)) {
          uniqueUsers.set(u.email, u);
        }
      });
      
      return NextResponse.json({ 
        enterprise,
        availableUsers: Array.from(uniqueUsers.values())
      });
    }
    
    const db = await getDb();
    const enterprises = await db.collection("enterprise_accounts").find({}).toArray();
    return NextResponse.json({ enterprises });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    const { name, shopIds } = body;
    
    if (!name) {
      return NextResponse.json({ error: "Enterprise name is required" }, { status: 400 });
    }
    
    const enterprise = await createEnterprise(name, shopIds || []);
    
    if (shopIds?.length > 0) {
      const db = await getDb();
      await db.collection("shops").updateMany(
        { shopId: { $in: shopIds } },
        { $set: { enterpriseId: enterprise._id, updatedAt: new Date() } }
      );
    }
    
    return NextResponse.json({ enterprise });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    const { enterpriseId, shopId, action } = body;
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    const db = await getDb();
    
    if (action === "add_shop" && shopId) {
      const numericShopId = Number(shopId);
      await addShopToEnterprise(enterpriseId, numericShopId);
      
      // Get existing enterprise shops to copy features from
      const enterprise = await getEnterpriseById(enterpriseId);
      let featuresToCopy: string[] = [];
      
      if (enterprise && enterprise.shopIds.length > 0) {
        // Filter out the new shop from the list of existing shops
        const otherShopIds = enterprise.shopIds.filter((id: number) => Number(id) !== numericShopId);
        console.log(`[Enterprise] Adding shop ${numericShopId} to enterprise. Other shops:`, otherShopIds);
        
        if (otherShopIds.length > 0) {
          // Get features from existing enterprise shops - check for non-empty array
          const existingShops = await db.collection("shops")
            .find({ 
              shopId: { $in: otherShopIds },
              enabledFeatures: { $exists: true, $type: "array" }
            })
            .project({ shopId: 1, enabledFeatures: 1 })
            .toArray();
          
          console.log(`[Enterprise] Found ${existingShops.length} shops with enabledFeatures field`);
          
          // Find a shop with actual features
          const shopWithFeatures = existingShops.find((s: any) => 
            Array.isArray(s.enabledFeatures) && s.enabledFeatures.length > 0
          );
          
          if (shopWithFeatures) {
            featuresToCopy = shopWithFeatures.enabledFeatures;
            console.log(`[Enterprise] Copying features from shop ${shopWithFeatures.shopId} to new location ${numericShopId}:`, featuresToCopy);
          } else {
            console.log(`[Enterprise] No shops with enabled features found`);
          }
        }
      }
      
      // Update the new shop with enterprise ID and copied features
      const updateFields: Record<string, any> = { 
        enterpriseId: new ObjectId(enterpriseId), 
        updatedAt: new Date() 
      };
      
      if (featuresToCopy.length > 0) {
        updateFields.enabledFeatures = featuresToCopy;
      }
      
      await db.collection("shops").updateOne(
        { shopId: numericShopId },
        { $set: updateFields }
      );
      
      return NextResponse.json({ ok: true, featuresCopied: featuresToCopy.length });
    }
    
    if (action === "remove_shop" && shopId) {
      await removeShopFromEnterprise(enterpriseId, shopId);
      
      await db.collection("shops").updateOne(
        { shopId },
        { $unset: { enterpriseId: "" }, $set: { updatedAt: new Date() } }
      );
      
      return NextResponse.json({ ok: true });
    }
    
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
