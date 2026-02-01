import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { getRepairOrders } from "@/lib/tekmetric";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);

  try {
    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
    const shop = shopRows[0] as any;
    
    const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetric_shop_id;
    if (!tekmetricShopId) {
      return NextResponse.json({ labels: [] });
    }

    const labelMap = new Map<string, { color: string; count: number }>();

    const syncedLabels = await sql`
      SELECT label, label_color, COUNT(*)::int as count
      FROM tekmetric_work_orders
      WHERE shop_id = ${shopId} AND label IS NOT NULL AND label != ''
      GROUP BY label, label_color
    `;

    for (const l of syncedLabels) {
      const ll = l as any;
      labelMap.set(ll.label, { color: ll.label_color || "", count: ll.count });
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
  } catch (error) {
    console.error("Error fetching labels:", error);
    return NextResponse.json({ error: "Failed to fetch labels" }, { status: 500 });
  }
}
