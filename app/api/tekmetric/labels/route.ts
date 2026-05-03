import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getRepairOrders } from "@/lib/integrations/tekmetric";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const db = await getDb();

  try {
    const shop = await db.collection("shops").findOne({
      shopId: { $in: [String(shopId), Number(shopId)] }
    });
    
    const tekmetricShopId = shop?.tekmetric?.shopId;
    if (!tekmetricShopId) {
      return NextResponse.json({ labels: [] });
    }

    const labelMap = new Map<string, { color: string; count: number }>();

    const syncedLabels = await db.collection("tekmetric_work_orders").aggregate([
      {
        $match: {
          shopId: { $in: [String(shopId), Number(shopId)] },
          label: { $exists: true, $nin: ["", null] }
        }
      },
      {
        $group: {
          _id: "$label",
          color: { $first: "$labelColor" },
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    for (const l of syncedLabels) {
      labelMap.set(l._id, { color: l.color || "", count: l.count });
    }

    try {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      const historicalResponse = await getRepairOrders(tekmetricShopId, {
        updatedDateStart: sixMonthsAgo.toISOString().split('T')[0],
        size: 300
      });
      
      const historicalROs = historicalResponse.content || [];

      for (const ro of historicalROs) {
        const labelName = (ro as any).repairOrderCustomLabel?.name || 
                          (ro as any).repairOrderLabel?.name || "";
        if (labelName && !labelMap.has(labelName)) {
          labelMap.set(labelName, { 
            color: (ro as any).color || "", 
            count: 1 
          });
        } else if (labelName) {
          const existing = labelMap.get(labelName)!;
          labelMap.set(labelName, { ...existing, count: existing.count + 1 });
        }
      }
    } catch (apiErr) {
      console.log("[Tekmetric Labels] API fetch skipped:", (apiErr as Error).message);
    }

    const labels = Array.from(labelMap.entries())
      .map(([name, data]) => ({ name, color: data.color, count: data.count }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({ labels });
  } catch (err: any) {
    console.error("[Tekmetric Labels] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
