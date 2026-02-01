import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { getNormalizedCache, CACHE_KEYS, CACHE_TTL } from "@/lib/normalized-cache";

export const dynamic = "force-dynamic";

const MAX_SUGGESTIONS = 10;
const MIN_QUERY_LENGTH = 2;

interface AutocompleteSuggestion {
  title: string;
  description?: string;
  avgHours?: number;
  avgTotal?: number;
  avgLaborTotal?: number;
  avgPartsTotal?: number;
  occurrences: number;
  lastPerformed?: Date;
  vehicleMatch: boolean;
  cannedJobCode?: string;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);
  const url = new URL(req.url);
  const query = url.searchParams.get("q") || "";
  const vin = url.searchParams.get("vin") || "";
  const year = url.searchParams.get("year") || "";
  const make = url.searchParams.get("make") || "";
  const model = url.searchParams.get("model") || "";
  const includeEnterprise = url.searchParams.get("enterprise") === "true";

  if (query.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ suggestions: [] });
  }

  const cache = getNormalizedCache();
  
  let enterpriseShopIds: string[] = [shopId];
  if (includeEnterprise) {
    const enterpriseCacheKey = { shopId };
    let cachedEnterpriseShops = cache.get<string[]>(CACHE_KEYS.ENTERPRISE_SHOPS, enterpriseCacheKey);
    
    if (!cachedEnterpriseShops) {
      const shopRows = await sql`SELECT enterprise_id FROM shops WHERE shop_id = ${shopId}`;
      const enterpriseId = shopRows[0]?.enterprise_id as string | undefined;
      
      if (enterpriseId) {
        const enterpriseShops = await sql`SELECT shop_id FROM shops WHERE enterprise_id = ${enterpriseId}`;
        cachedEnterpriseShops = enterpriseShops.map((s: any) => s.shop_id);
        cache.set(CACHE_KEYS.ENTERPRISE_SHOPS, enterpriseCacheKey, cachedEnterpriseShops, CACHE_TTL.LONG);
      } else {
        cachedEnterpriseShops = [shopId];
      }
    }
    enterpriseShopIds = cachedEnterpriseShops;
  }

  const cacheKey = { 
    shopId, 
    query: query.toLowerCase().trim(), 
    vin, 
    year, 
    make, 
    model, 
    includeEnterprise 
  };
  
  const cached = cache.get<AutocompleteSuggestion[]>(CACHE_KEYS.JOB_AUTOCOMPLETE, cacheKey);
  if (cached) {
    return NextResponse.json({ suggestions: cached, cached: true });
  }

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  const searchPattern = queryWords.map(w => `%${w}%`).join('%');
  
  const hasVehicleContext = vin || year || make || model;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  
  let rows: any[];
  
  if (hasVehicleContext) {
    const yearNum = year ? parseInt(year) : null;
    rows = await sql`
      WITH job_data AS (
        SELECT 
          sj.title,
          sj.description,
          sj.canned_job_code,
          sj.labor_hours_billed,
          sj.labor_hours_actual,
          sj.total,
          sj.labor_total,
          sj.parts_total,
          wo.closed_date,
          v.vin as vehicle_vin,
          v.year as vehicle_year,
          v.make as vehicle_make,
          v.model as vehicle_model,
          CASE 
            WHEN (${vin} = '' OR UPPER(v.vin) = UPPER(${vin}))
              AND (${yearNum}::int IS NULL OR v.year = ${yearNum})
              AND (${make} = '' OR LOWER(v.make) = LOWER(${make}))
              AND (${model} = '' OR LOWER(v.model) = LOWER(${model}))
            THEN 1 ELSE 0
          END as vehicle_match
        FROM service_jobs sj
        LEFT JOIN work_orders wo ON sj.work_order_id = wo.id::text
        LEFT JOIN vehicles v ON wo.vehicle_id = v.id::text
        WHERE sj.shop_id = ANY(${enterpriseShopIds})
          AND (sj.soft_delete IS NULL OR sj.soft_delete->>'isDeleted' != 'true')
          AND sj.status IN ('completed', 'authorized')
          AND LOWER(sj.title) LIKE ${`%${searchPattern}%`}
      )
      SELECT 
        LOWER(TRIM(title)) as job_key,
        MIN(title) as title,
        MIN(description) as description,
        MIN(canned_job_code) as canned_job_code,
        AVG(COALESCE(labor_hours_billed, labor_hours_actual))::float as avg_hours,
        AVG(total)::float as avg_total,
        AVG(labor_total)::float as avg_labor_total,
        AVG(parts_total)::float as avg_parts_total,
        COUNT(*)::int as count,
        MAX(closed_date) as last_performed,
        SUM(vehicle_match)::int as vehicle_match_count,
        (COUNT(*) + SUM(vehicle_match) * 10 + 
          CASE WHEN MAX(closed_date) > ${ninetyDaysAgo} THEN 5 ELSE 0 END) as relevance_score
      FROM job_data
      GROUP BY LOWER(TRIM(title))
      ORDER BY relevance_score DESC, count DESC
      LIMIT ${MAX_SUGGESTIONS}
    `;
  } else {
    rows = await sql`
      WITH job_data AS (
        SELECT 
          sj.title,
          sj.description,
          sj.canned_job_code,
          sj.labor_hours_billed,
          sj.labor_hours_actual,
          sj.total,
          sj.labor_total,
          sj.parts_total,
          wo.closed_date
        FROM service_jobs sj
        LEFT JOIN work_orders wo ON sj.work_order_id = wo.id::text
        WHERE sj.shop_id = ANY(${enterpriseShopIds})
          AND (sj.soft_delete IS NULL OR sj.soft_delete->>'isDeleted' != 'true')
          AND sj.status IN ('completed', 'authorized')
          AND LOWER(sj.title) LIKE ${`%${searchPattern}%`}
      )
      SELECT 
        LOWER(TRIM(title)) as job_key,
        MIN(title) as title,
        MIN(description) as description,
        MIN(canned_job_code) as canned_job_code,
        AVG(COALESCE(labor_hours_billed, labor_hours_actual))::float as avg_hours,
        AVG(total)::float as avg_total,
        AVG(labor_total)::float as avg_labor_total,
        AVG(parts_total)::float as avg_parts_total,
        COUNT(*)::int as count,
        MAX(closed_date) as last_performed,
        0 as vehicle_match_count,
        (COUNT(*) + 
          CASE WHEN MAX(closed_date) > ${ninetyDaysAgo} THEN 5 ELSE 0 END) as relevance_score
      FROM job_data
      GROUP BY LOWER(TRIM(title))
      ORDER BY relevance_score DESC, count DESC
      LIMIT ${MAX_SUGGESTIONS}
    `;
  }

  const suggestions: AutocompleteSuggestion[] = rows.map((job: any) => ({
    title: job.title,
    description: job.description,
    avgHours: job.avg_hours ? Math.round(job.avg_hours * 10) / 10 : undefined,
    avgTotal: job.avg_total ? Math.round(job.avg_total * 100) / 100 : undefined,
    avgLaborTotal: job.avg_labor_total ? Math.round(job.avg_labor_total * 100) / 100 : undefined,
    avgPartsTotal: job.avg_parts_total ? Math.round(job.avg_parts_total * 100) / 100 : undefined,
    occurrences: job.count,
    lastPerformed: job.last_performed,
    vehicleMatch: job.vehicle_match_count > 0,
    cannedJobCode: job.canned_job_code,
  }));

  cache.set(CACHE_KEYS.JOB_AUTOCOMPLETE, cacheKey, suggestions, CACHE_TTL.SHORT);

  return NextResponse.json({ suggestions, cached: false });
}
