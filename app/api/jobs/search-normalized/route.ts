import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

const BATCH_SIZE = 200;

interface SearchResult {
  _id: string;
  workOrderId: string;
  workOrderNumber: string;
  title: string;
  description?: string;
  hours?: number;
  total?: number;
  laborTotal?: number;
  partsTotal?: number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  engine?: string;
  closedDate?: Date;
  sourceSystem: string;
  shopId: number;
  score: number;
}

interface PaginatedResponse {
  results: SearchResult[];
  pagination: {
    limit: number;
    total?: number;
    hasMore: boolean;
    nextCursor?: string;
  };
  source: string;
  cached?: boolean;
  meta?: {
    queryTimeMs: number;
  };
}

function scoreJob(job: Record<string, unknown>, query: string, shopId: number): number {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  let score = 0;
  const title = ((job.title as string) || '').toLowerCase();
  const description = ((job.description as string) || '').toLowerCase();
  
  if (title === queryLower) {
    score += 100;
  } else if (title.includes(queryLower)) {
    score += 50;
  }
  
  for (const word of queryWords) {
    if (title.includes(word)) score += 10;
    if (description.includes(word)) score += 5;
  }
  
  if (Number(job.shopId) === shopId) {
    score += 20;
  }
  
  if (job.closedDate) {
    const daysSinceClosed = (Date.now() - new Date(job.closedDate as string).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceClosed < 30) score += 10;
    else if (daysSinceClosed < 90) score += 5;
    else if (daysSinceClosed < 365) score += 2;
  }
  
  if (job.hours && Number(job.hours) > 0) score += 5;
  if (job.total && Number(job.total) > 0) score += 5;
  
  return score;
}

export async function GET(req: NextRequest) {
  const startTime = Date.now();
  
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const url = new URL(req.url);
  const query = url.searchParams.get("q") || "";
  const vin = url.searchParams.get("vin") || "";
  const year = url.searchParams.get("year") || "";
  const make = url.searchParams.get("make") || "";
  const model = url.searchParams.get("model") || "";
  const includeEnterprise = url.searchParams.get("enterprise") === "true";
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50")), 100);
  const cursorParam = url.searchParams.get("cursor") || undefined;

  if (!query && !vin) {
    return NextResponse.json({ error: "Missing query or VIN" }, { status: 400 });
  }

  let enterpriseShopIds: string[] = [String(shopId)];
  if (includeEnterprise) {
    const shopResult = await sql`
      SELECT enterprise_id FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;
    const enterpriseId = shopResult[0]?.enterprise_id;
    
    if (enterpriseId) {
      const enterpriseShops = await sql`
        SELECT shop_id FROM shops WHERE enterprise_id = ${enterpriseId}
      `;
      enterpriseShopIds = enterpriseShops.map((s: Record<string, unknown>) => String(s.shop_id));
    }
  }

  let results;
  
  if (vin) {
    results = await sql`
      SELECT 
        sj.id as "_id",
        sj.work_order_id as "workOrderId",
        wo.work_order_number as "workOrderNumber",
        sj.title,
        sj.description,
        COALESCE(sj.labor_hours_billed, sj.labor_hours_actual) as hours,
        sj.total,
        sj.labor_total as "laborTotal",
        sj.parts_total as "partsTotal",
        v.vin,
        v.year,
        v.make,
        v.model,
        v.engine_description as engine,
        wo.closed_date as "closedDate",
        COALESCE(sj.source_system, 'unknown') as "sourceSystem",
        sj.shop_id as "shopId"
      FROM normalized_service_jobs sj
      LEFT JOIN normalized_work_orders wo ON sj.work_order_id = wo.id::text
      LEFT JOIN normalized_vehicles v ON wo.vehicle_id = v.id::text
      WHERE sj.shop_id = ANY(${enterpriseShopIds})
        AND (sj.soft_delete IS NULL OR (sj.soft_delete->>'isDeleted')::boolean != TRUE)
        AND v.vin = ${vin.toUpperCase()}
      ORDER BY wo.closed_date DESC NULLS LAST
      LIMIT ${BATCH_SIZE + 1}
    `;
  } else {
    const searchPattern = `%${query}%`;
    results = await sql`
      SELECT 
        sj.id as "_id",
        sj.work_order_id as "workOrderId",
        wo.work_order_number as "workOrderNumber",
        sj.title,
        sj.description,
        COALESCE(sj.labor_hours_billed, sj.labor_hours_actual) as hours,
        sj.total,
        sj.labor_total as "laborTotal",
        sj.parts_total as "partsTotal",
        v.vin,
        v.year,
        v.make,
        v.model,
        v.engine_description as engine,
        wo.closed_date as "closedDate",
        COALESCE(sj.source_system, 'unknown') as "sourceSystem",
        sj.shop_id as "shopId"
      FROM normalized_service_jobs sj
      LEFT JOIN normalized_work_orders wo ON sj.work_order_id = wo.id::text
      LEFT JOIN normalized_vehicles v ON wo.vehicle_id = v.id::text
      WHERE sj.shop_id = ANY(${enterpriseShopIds})
        AND (sj.soft_delete IS NULL OR (sj.soft_delete->>'isDeleted')::boolean != TRUE)
        AND (sj.title ILIKE ${searchPattern} OR sj.description ILIKE ${searchPattern})
      ORDER BY wo.closed_date DESC NULLS LAST
      LIMIT ${BATCH_SIZE + 1}
    `;
  }

  const hasMore = results.length > BATCH_SIZE;
  const resultsToProcess = hasMore ? results.slice(0, BATCH_SIZE) : results;
  
  const scoredResults: SearchResult[] = resultsToProcess.map((job: Record<string, unknown>) => ({
    _id: String(job._id),
    workOrderId: String(job.workOrderId || ''),
    workOrderNumber: (job.workOrderNumber as string) || '',
    title: (job.title as string) || '',
    description: job.description as string | undefined,
    hours: job.hours as number | undefined,
    total: job.total as number | undefined,
    laborTotal: job.laborTotal as number | undefined,
    partsTotal: job.partsTotal as number | undefined,
    vin: job.vin as string | undefined,
    year: job.year as number | undefined,
    make: job.make as string | undefined,
    model: job.model as string | undefined,
    engine: job.engine as string | undefined,
    closedDate: job.closedDate as Date | undefined,
    sourceSystem: (job.sourceSystem as string) || 'unknown',
    shopId: Number(job.shopId),
    score: scoreJob(job, query, shopId),
  }));

  scoredResults.sort((a, b) => b.score - a.score);

  const nextCursor = hasMore ? String(resultsToProcess[resultsToProcess.length - 1]._id) : undefined;
  const paginatedResults = scoredResults.slice(0, limit);
  
  return NextResponse.json({
    results: paginatedResults,
    pagination: {
      limit,
      hasMore: hasMore || scoredResults.length > limit,
      nextCursor: scoredResults.length > limit 
        ? scoredResults[limit - 1]._id 
        : nextCursor,
    },
    source: 'normalized',
    cached: false,
    meta: { queryTimeMs: Date.now() - startTime },
  } as PaginatedResponse);
}
