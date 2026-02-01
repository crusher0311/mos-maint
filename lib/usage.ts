import sql from "@/lib/db/postgres";

export interface UsageLog {
  id?: number;
  shopId: number | string;
  userId?: string;
  userEmail?: string;
  action: "analyze" | "chat" | "other";
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  vin?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4.1": { input: 0.15, output: 0.60 },
  "gpt-4.1-mini": { input: 0.15, output: 0.60 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 5.0, output: 15.0 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-4": { input: 30.0, output: 60.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["gpt-4o-mini"];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function logUsage(log: Omit<UsageLog, "id" | "createdAt" | "estimatedCost"> & { estimatedCost?: number }) {
  const cost = log.estimatedCost ?? estimateCost(log.model, log.inputTokens, log.outputTokens);
  
  await sql`
    INSERT INTO ai_usage_logs (shop_id, user_id, user_email, action, model, input_tokens, output_tokens, total_tokens, estimated_cost, vin, metadata)
    VALUES (
      ${String(log.shopId)},
      ${log.userId || null},
      ${log.userEmail || null},
      ${log.action},
      ${log.model},
      ${log.inputTokens},
      ${log.outputTokens},
      ${log.totalTokens},
      ${cost},
      ${log.vin || null},
      ${JSON.stringify(log.metadata || {})}::jsonb
    )
  `;
}

export async function getUsageByShop(shopId: number | string, startDate?: Date, endDate?: Date) {
  const shopIdStr = String(shopId);
  
  let rows;
  if (startDate && endDate) {
    rows = await sql`
      SELECT action, model,
        COUNT(*) as count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(estimated_cost) as total_cost
      FROM ai_usage_logs
      WHERE shop_id = ${shopIdStr}
        AND created_at >= ${startDate}
        AND created_at <= ${endDate}
      GROUP BY action, model
    `;
  } else if (startDate) {
    rows = await sql`
      SELECT action, model,
        COUNT(*) as count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(estimated_cost) as total_cost
      FROM ai_usage_logs
      WHERE shop_id = ${shopIdStr}
        AND created_at >= ${startDate}
      GROUP BY action, model
    `;
  } else if (endDate) {
    rows = await sql`
      SELECT action, model,
        COUNT(*) as count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(estimated_cost) as total_cost
      FROM ai_usage_logs
      WHERE shop_id = ${shopIdStr}
        AND created_at <= ${endDate}
      GROUP BY action, model
    `;
  } else {
    rows = await sql`
      SELECT action, model,
        COUNT(*) as count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(estimated_cost) as total_cost
      FROM ai_usage_logs
      WHERE shop_id = ${shopIdStr}
      GROUP BY action, model
    `;
  }
  
  return rows.map(row => ({
    _id: { action: row.action, model: row.model },
    count: Number(row.count),
    totalInputTokens: Number(row.total_input_tokens),
    totalOutputTokens: Number(row.total_output_tokens),
    totalTokens: Number(row.total_tokens),
    totalCost: Number(row.total_cost),
  }));
}

export async function getUsageAnalytics(startDate?: Date, endDate?: Date) {
  const dateFilter = startDate && endDate
    ? sql`AND created_at >= ${startDate} AND created_at <= ${endDate}`
    : startDate
    ? sql`AND created_at >= ${startDate}`
    : endDate
    ? sql`AND created_at <= ${endDate}`
    : sql``;

  const byShopRows = await sql`
    SELECT shop_id,
      COUNT(*) as request_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(estimated_cost) as total_cost,
      ARRAY_AGG(DISTINCT vin) FILTER (WHERE vin IS NOT NULL) as unique_vins
    FROM ai_usage_logs
    WHERE 1=1 ${dateFilter}
    GROUP BY shop_id
    ORDER BY SUM(estimated_cost) DESC
  `;
  
  const byModelRows = await sql`
    SELECT model,
      COUNT(*) as request_count,
      SUM(estimated_cost) as total_cost
    FROM ai_usage_logs
    WHERE 1=1 ${dateFilter}
    GROUP BY model
  `;
  
  const byDayRows = await sql`
    SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as day,
      COUNT(*) as request_count,
      SUM(estimated_cost) as total_cost
    FROM ai_usage_logs
    WHERE 1=1 ${dateFilter}
    GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
    ORDER BY day ASC
  `;
  
  const totalsRows = await sql`
    SELECT 
      COUNT(*) as request_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(estimated_cost) as total_cost,
      ARRAY_AGG(DISTINCT vin) FILTER (WHERE vin IS NOT NULL) as unique_vins
    FROM ai_usage_logs
    WHERE 1=1 ${dateFilter}
  `;
  
  const shopIds = byShopRows.map(s => s.shop_id as string);
  const shopRows = shopIds.length > 0
    ? await sql`SELECT shop_id, name FROM shops WHERE shop_id = ANY(${shopIds})`
    : [];
  const shopMap = new Map(shopRows.map(s => [s.shop_id as string, s.name as string]));

  const viewDateFilter = startDate && endDate
    ? sql`WHERE first_viewed_at >= ${startDate} AND first_viewed_at <= ${endDate}`
    : startDate
    ? sql`WHERE first_viewed_at >= ${startDate}`
    : endDate
    ? sql`WHERE first_viewed_at <= ${endDate}`
    : sql``;
    
  const viewCountRows = await sql`
    SELECT COUNT(*) as count FROM viewed_vins ${viewDateFilter}
  `;
  const totalViews = Number(viewCountRows[0]?.count || 0);
  
  const totals = totalsRows[0] || {};
  const totalCost = Number(totals.total_cost || 0);
  const uniqueVinsArray = (totals.unique_vins as string[] || []).filter(Boolean);
  const uniqueVinsProcessed = uniqueVinsArray.length;
  const costPerVin = uniqueVinsProcessed > 0 ? totalCost / uniqueVinsProcessed : 0;
  const costPerView = totalViews > 0 ? totalCost / totalViews : 0;
  
  const shopBreakdown = byShopRows.map(s => ({
    shopId: s.shop_id,
    shopName: shopMap.get(s.shop_id as string) || `Shop ${s.shop_id}`,
    requestCount: Number(s.request_count),
    totalTokens: Number(s.total_tokens),
    totalCost: Number(s.total_cost),
    uniqueVins: ((s.unique_vins as string[]) || []).filter(Boolean).length,
  }));
  
  return {
    totals: {
      requestCount: Number(totals.request_count || 0),
      totalInputTokens: Number(totals.total_input_tokens || 0),
      totalOutputTokens: Number(totals.total_output_tokens || 0),
      totalTokens: Number(totals.total_tokens || 0),
      totalCost,
      uniqueVinsProcessed,
      totalViews,
      costPerVin,
      costPerView,
    },
    byShop: shopBreakdown,
    byModel: byModelRows.map(r => ({
      _id: r.model,
      requestCount: Number(r.request_count),
      totalCost: Number(r.total_cost),
    })),
    byDay: byDayRows.map(r => ({
      _id: r.day,
      requestCount: Number(r.request_count),
      totalCost: Number(r.total_cost),
    })),
  };
}
