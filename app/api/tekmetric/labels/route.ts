// API to get unique Tekmetric custom labels from synced work orders
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const db = await getDb();

  try {
    // Get unique labels from synced Tekmetric work orders
    const pipeline = [
      {
        $match: {
          shopId: { $in: [String(shopId), Number(shopId)] },
          label: { $exists: true, $ne: "", $ne: null }
        }
      },
      {
        $group: {
          _id: "$label",
          color: { $first: "$labelColor" },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          name: "$_id",
          color: 1,
          count: 1,
          _id: 0
        }
      },
      {
        $sort: { count: -1 }
      }
    ];

    const labels = await db.collection("tekmetric_work_orders")
      .aggregate(pipeline)
      .toArray();

    return NextResponse.json({ labels });
  } catch (err: any) {
    console.error("[Tekmetric Labels] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
