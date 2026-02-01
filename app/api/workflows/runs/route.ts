import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shopId = String(sess.shopId);

  const runs = await sql`
    SELECT * FROM workflow_runs 
    WHERE shop_id = ${shopId}
    ORDER BY scheduled_for DESC
    LIMIT 50
  `;

  const stats = await sql`
    SELECT 
      SUM(CASE WHEN status IN ('sent', 'delivered') THEN 1 ELSE 0 END)::int as total_sent,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)::int as pending,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END)::int as delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int as failed
    FROM workflow_runs
    WHERE shop_id = ${shopId}
  `;

  const statsResult = stats[0] as any || { total_sent: 0, pending: 0, delivered: 0, failed: 0 };

  return NextResponse.json({
    runs: runs.map((r: any) => ({
      id: r.id,
      workflowName: r.workflow_name,
      customerName: r.customer_name,
      vehicleInfo: r.vehicle_info,
      status: r.status,
      scheduledFor: r.scheduled_for,
      completedAt: r.completed_at,
    })),
    stats: {
      totalSent: statsResult.total_sent || 0,
      pending: statsResult.pending || 0,
      delivered: statsResult.delivered || 0,
      failed: statsResult.failed || 0,
    },
  });
}
