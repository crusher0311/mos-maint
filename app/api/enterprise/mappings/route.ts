import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getEnterpriseById } from "@/lib/enterprise";
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
    const enterpriseId = searchParams.get("enterpriseId");
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    const enterprise = await getEnterpriseById(enterpriseId);
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }
    
    return NextResponse.json({
      mappings: enterprise.sharedMappings?.cannedJobs || {},
      updatedAt: enterprise.sharedMappings?.updatedAt
    });
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
    const { enterpriseId, mappings, applyToAllShops } = body;
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    const db = await getDb();
    const now = new Date();
    
    await db.collection("enterprise_accounts").updateOne(
      { _id: new ObjectId(enterpriseId) },
      {
        $set: {
          "sharedMappings.cannedJobs": mappings,
          "sharedMappings.updatedAt": now,
          updatedAt: now
        }
      }
    );
    
    if (applyToAllShops) {
      const enterprise = await getEnterpriseById(enterpriseId);
      if (enterprise) {
        for (const shopId of enterprise.shopIds) {
          await db.collection("shops").updateOne(
            { shopId },
            {
              $set: {
                "cannedJobMappings": mappings,
                "cannedJobMappingsSource": "enterprise",
                updatedAt: now
              }
            }
          );
        }
      }
    }
    
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
