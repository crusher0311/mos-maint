import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface JobHistoryPreferences {
  enabled: boolean;
  priorityShopIds: number[];
  excludeOthers: boolean;
}

export interface UserPreferences {
  jobHistory?: JobHistoryPreferences;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = await getDb();
    const user = await db.collection("users").findOne(
      { email: session.email },
      { projection: { preferences: 1 } }
    );

    const preferences: UserPreferences = user?.preferences || {};

    return NextResponse.json({
      ok: true,
      preferences,
    });
  } catch (err: any) {
    console.error("Error fetching user preferences:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = await getDb();
    const body = await req.json();

    const updateFields: Record<string, any> = {};

    if (body.jobHistory !== undefined) {
      const jh = body.jobHistory;
      
      if (typeof jh.enabled !== "boolean") {
        return NextResponse.json({ error: "jobHistory.enabled must be a boolean" }, { status: 400 });
      }
      
      if (!Array.isArray(jh.priorityShopIds)) {
        return NextResponse.json({ error: "jobHistory.priorityShopIds must be an array" }, { status: 400 });
      }
      
      const priorityShopIds = jh.priorityShopIds.map((id: any) => Number(id)).filter((id: number) => !isNaN(id));
      
      const sessionShopId = String(session.shopId);
      const sessionShop = await db.collection("shops").findOne({
        shopId: { $in: [sessionShopId, Number(sessionShopId)] }
      });
      
      const enterpriseId = sessionShop?.enterpriseId;
      let allowedShopIds: number[] = [Number(session.shopId)];
      
      if (enterpriseId) {
        const enterpriseShops = await db.collection("shops")
          .find({ enterpriseId })
          .project({ shopId: 1 })
          .toArray();
        allowedShopIds = enterpriseShops.map(s => Number(s.shopId));
      } else {
        const user = await db.collection("users").findOne({ email: session.email });
        const userShopIds = [session.shopId, ...(user?.shopIds || [])].map(id => Number(id));
        allowedShopIds = userShopIds;
      }
      
      const invalidShopIds = priorityShopIds.filter((id: number) => !allowedShopIds.includes(id));
      if (invalidShopIds.length > 0) {
        return NextResponse.json({ 
          error: "Cannot set priority for shops outside your access" 
        }, { status: 403 });
      }
      
      updateFields["preferences.jobHistory"] = {
        enabled: jh.enabled,
        priorityShopIds: priorityShopIds,
        excludeOthers: Boolean(jh.excludeOthers),
      };
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    updateFields.updatedAt = new Date();

    await db.collection("users").updateOne(
      { email: session.email },
      { $set: updateFields }
    );

    console.log(`[Preferences] User ${session.email} updated preferences:`, Object.keys(body));

    return NextResponse.json({
      ok: true,
      message: "Preferences updated successfully",
    });
  } catch (err: any) {
    console.error("Error updating user preferences:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
