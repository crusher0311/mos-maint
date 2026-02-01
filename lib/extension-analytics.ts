import sql from "@/lib/db/postgres";

export interface PushToROEvent {
  shopId: number;
  userId?: string;
  enterpriseId?: string;
  vin?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  jobTitle: string;
  jobSource: "plan" | "failures" | "lookup" | "canned" | "autocomplete" | "deferred";
  repairOrderId?: string;
  laborAmount?: number;
  partsAmount?: number;
  totalAmount?: number;
  timestamp: Date;
}

export async function trackPushToRO(event: Omit<PushToROEvent, "timestamp">): Promise<void> {
  const shopIdStr = String(event.shopId);
  
  const eventData = {
    vin: event.vin,
    vehicleYear: event.vehicleYear,
    vehicleMake: event.vehicleMake,
    vehicleModel: event.vehicleModel,
    jobTitle: event.jobTitle,
    jobSource: event.jobSource,
    repairOrderId: event.repairOrderId,
    laborAmount: event.laborAmount,
    partsAmount: event.partsAmount,
    totalAmount: event.totalAmount,
  };
  
  await sql`
    INSERT INTO extension_analytics (shop_id, user_id, event_type, event_data, created_at)
    VALUES (
      (SELECT id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1),
      ${event.userId ? sql`(SELECT id FROM users WHERE id::text = ${event.userId} LIMIT 1)` : sql`NULL`},
      'push_to_ro',
      ${JSON.stringify(eventData)}::jsonb,
      NOW()
    )
  `;
}

export async function getPushToROStats(params: {
  shopId?: number;
  enterpriseId?: string;
  startDate?: Date;
  endDate?: Date;
}): Promise<{
  totalPushes: number;
  bySource: Record<string, number>;
  byDay: Array<{ date: string; count: number }>;
  topJobs: Array<{ jobTitle: string; count: number }>;
}> {
  const shopIdStr = params.shopId ? String(params.shopId) : null;
  
  const baseFilter = sql`
    WHERE event_type = 'push_to_ro'
    ${shopIdStr ? sql`AND shop_id = (SELECT id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1)` : sql``}
    ${params.startDate ? sql`AND created_at >= ${params.startDate}` : sql``}
    ${params.endDate ? sql`AND created_at <= ${params.endDate}` : sql``}
  `;

  const [totalRows, bySourceRows, byDayRows, topJobsRows] = await Promise.all([
    sql`SELECT COUNT(*) as count FROM extension_analytics ${baseFilter}`,
    
    sql`
      SELECT event_data->>'jobSource' as source, COUNT(*) as count
      FROM extension_analytics
      ${baseFilter}
      GROUP BY event_data->>'jobSource'
    `,
    
    sql`
      SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as day, COUNT(*) as count
      FROM extension_analytics
      ${baseFilter}
      GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
      ORDER BY day DESC
      LIMIT 30
    `,
    
    sql`
      SELECT event_data->>'jobTitle' as job_title, COUNT(*) as count
      FROM extension_analytics
      ${baseFilter}
      GROUP BY event_data->>'jobTitle'
      ORDER BY count DESC
      LIMIT 20
    `,
  ]);

  const bySource: Record<string, number> = {};
  for (const row of bySourceRows) {
    bySource[(row.source as string) || "unknown"] = Number(row.count);
  }

  return {
    totalPushes: Number(totalRows[0]?.count || 0),
    bySource,
    byDay: byDayRows.map(r => ({ date: r.day as string, count: Number(r.count) })),
    topJobs: topJobsRows.map(r => ({ jobTitle: r.job_title as string, count: Number(r.count) })),
  };
}
