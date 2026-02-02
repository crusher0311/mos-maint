import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();

  const runs = await db.collection("workflow_runs")
    .find({ shopId: sess.shopId })
    .sort({ scheduledFor: -1 })
    .limit(50)
    .toArray();

  const stats = await db.collection("workflow_runs").aggregate([
    { $match: { shopId: sess.shopId } },
    {
      $group: {
        _id: null,
        totalSent: { $sum: { $cond: [{ $in: ["$status", ["sent", "delivered"]] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
      },
    },
  ]).toArray();

  const statsResult = stats[0] || { totalSent: 0, pending: 0, delivered: 0, failed: 0 };

  return NextResponse.json({
    runs: runs.map((r) => ({
      id: r._id.toString(),
      workflowName: r.workflowName,
      customerName: r.customerName,
      vehicleInfo: r.vehicleInfo,
      status: r.status,
      scheduledFor: r.scheduledFor,
      completedAt: r.completedAt,
    })),
    stats: {
      totalSent: statsResult.totalSent,
      pending: statsResult.pending,
      delivered: statsResult.delivered,
      failed: statsResult.failed,
    },
  });
}
