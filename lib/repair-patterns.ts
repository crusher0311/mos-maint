import sql from "@/lib/db/postgres";

export interface RepairPattern {
  id?: number;
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileageBucket: number;
  jobTitle: string;
  jobTitleNormalized: string;
  occurrences: number;
  totalLabor: number;
  totalParts: number;
  totalAmount: number;
  avgLabor: number;
  avgParts: number;
  avgTotal: number;
  avgHours: number;
  lastPerformed: Date;
  firstPerformed: Date;
  vinsSeen: string[];
  updatedAt: Date;
  createdAt: Date;
}

export interface PatternMatch {
  jobTitle: string;
  occurrences: number;
  avgTotal: number;
  avgHours: number;
  avgLabor: number;
  avgParts: number;
  lastPerformed: Date;
  confidence: "high" | "medium" | "low";
  mileageBucket: number;
  uniqueVehicles: number;
}

function getMileageBucket(mileage: number): number {
  return Math.floor(mileage / 5000) * 5000;
}

function normalizeJobTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export async function updateRepairPattern(params: {
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  jobTitle: string;
  laborAmount: number;
  partsAmount: number;
  totalAmount: number;
  laborHours: number;
  vin?: string;
  performedDate: Date;
}): Promise<void> {
  const mileageBucket = getMileageBucket(params.mileage);
  const jobTitleNormalized = normalizeJobTitle(params.jobTitle);
  const shopIdStr = String(params.shopId);
  const makeUpper = params.make.toUpperCase();
  const modelUpper = params.model.toUpperCase();
  
  const existingRows = await sql`
    SELECT id, occurrences, total_labor, total_parts, total_amount, avg_hours, vins_seen
    FROM shop_repair_patterns
    WHERE shop_id = ${shopIdStr}
      AND year = ${params.year}
      AND make = ${makeUpper}
      AND model = ${modelUpper}
      AND mileage_bucket = ${mileageBucket}
      AND job_title_normalized = ${jobTitleNormalized}
    LIMIT 1
  `;
  
  if (existingRows.length > 0) {
    const existing = existingRows[0];
    const newOccurrences = (existing.occurrences as number) + 1;
    const newTotalLabor = Number(existing.total_labor || 0) + (params.laborAmount || 0);
    const newTotalParts = Number(existing.total_parts || 0) + (params.partsAmount || 0);
    const newTotalAmount = Number(existing.total_amount || 0) + (params.totalAmount || 0);
    
    const oldAvgHours = Number(existing.avg_hours || 0);
    const newAvgHours = params.laborHours > 0 
      ? (oldAvgHours * (newOccurrences - 1) + params.laborHours) / newOccurrences
      : oldAvgHours;
    
    let vinsSeen = (existing.vins_seen || []) as string[];
    if (params.vin && !vinsSeen.includes(params.vin)) {
      vinsSeen = [...vinsSeen.slice(-99), params.vin];
    }
    
    await sql`
      UPDATE shop_repair_patterns
      SET 
        job_title = ${params.jobTitle},
        enterprise_id = ${params.enterpriseId || null},
        occurrences = ${newOccurrences},
        total_labor = ${newTotalLabor},
        total_parts = ${newTotalParts},
        total_amount = ${newTotalAmount},
        avg_labor = ${newTotalLabor / newOccurrences},
        avg_parts = ${newTotalParts / newOccurrences},
        avg_total = ${newTotalAmount / newOccurrences},
        avg_hours = ${newAvgHours},
        last_performed = GREATEST(last_performed, ${params.performedDate}),
        vins_seen = ${vinsSeen},
        updated_at = NOW()
      WHERE id = ${existing.id}
    `;
  } else {
    const vinsSeen = params.vin ? [params.vin] : [];
    
    await sql`
      INSERT INTO shop_repair_patterns (
        shop_id, enterprise_id, year, make, model, mileage_bucket,
        job_title, job_title_normalized, occurrences,
        total_labor, total_parts, total_amount,
        avg_labor, avg_parts, avg_total, avg_hours,
        first_performed, last_performed, vins_seen,
        created_at, updated_at
      )
      VALUES (
        ${shopIdStr},
        ${params.enterpriseId || null},
        ${params.year},
        ${makeUpper},
        ${modelUpper},
        ${mileageBucket},
        ${params.jobTitle},
        ${jobTitleNormalized},
        1,
        ${params.laborAmount || 0},
        ${params.partsAmount || 0},
        ${params.totalAmount || 0},
        ${params.laborAmount || 0},
        ${params.partsAmount || 0},
        ${params.totalAmount || 0},
        ${params.laborHours || 0},
        ${params.performedDate},
        ${params.performedDate},
        ${vinsSeen},
        NOW(),
        NOW()
      )
    `;
  }
}

export async function updateRepairPatternBatch(jobs: Array<{
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  jobTitle: string;
  laborAmount: number;
  partsAmount: number;
  totalAmount: number;
  laborHours: number;
  vin?: string;
  performedDate: Date;
}>): Promise<number> {
  if (jobs.length === 0) return 0;
  
  let updated = 0;
  
  for (const job of jobs) {
    try {
      await updateRepairPattern(job);
      updated++;
    } catch (err) {
      console.error("Error updating repair pattern:", err);
    }
  }
  
  return updated;
}

export async function getShopPatterns(params: {
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  includeEnterprise?: boolean;
  limit?: number;
}): Promise<PatternMatch[]> {
  const mileageBucket = getMileageBucket(params.mileage);
  const buckets = [mileageBucket - 5000, mileageBucket, mileageBucket + 5000].filter(b => b >= 0);
  const shopIdStr = String(params.shopId);
  const makeUpper = params.make.toUpperCase();
  const modelUpper = params.model.toUpperCase();
  const limit = params.limit || 20;
  
  let rows;
  
  if (params.includeEnterprise && params.enterpriseId) {
    rows = await sql`
      SELECT job_title, occurrences, avg_total, avg_hours, avg_labor, avg_parts, last_performed, mileage_bucket, vins_seen
      FROM shop_repair_patterns
      WHERE enterprise_id = ${params.enterpriseId}::uuid
        AND year = ${params.year}
        AND make = ${makeUpper}
        AND model = ${modelUpper}
        AND mileage_bucket = ANY(${buckets})
        AND occurrences >= 2
      ORDER BY occurrences DESC
      LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT job_title, occurrences, avg_total, avg_hours, avg_labor, avg_parts, last_performed, mileage_bucket, vins_seen
      FROM shop_repair_patterns
      WHERE shop_id = ${shopIdStr}
        AND year = ${params.year}
        AND make = ${makeUpper}
        AND model = ${modelUpper}
        AND mileage_bucket = ANY(${buckets})
        AND occurrences >= 2
      ORDER BY occurrences DESC
      LIMIT ${limit}
    `;
  }
  
  return rows.map(p => ({
    jobTitle: p.job_title as string,
    occurrences: p.occurrences as number,
    avgTotal: Math.round(Number(p.avg_total || 0) * 100) / 100,
    avgHours: Math.round(Number(p.avg_hours || 0) * 10) / 10,
    avgLabor: Math.round(Number(p.avg_labor || 0) * 100) / 100,
    avgParts: Math.round(Number(p.avg_parts || 0) * 100) / 100,
    lastPerformed: new Date(p.last_performed as string),
    mileageBucket: p.mileage_bucket as number,
    uniqueVehicles: ((p.vins_seen || []) as string[]).length,
    confidence: (p.occurrences as number) >= 10 ? "high" : (p.occurrences as number) >= 5 ? "medium" : "low",
  }));
}

export async function getEnterprisePatterns(params: {
  enterpriseId: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  limit?: number;
}): Promise<PatternMatch[]> {
  const mileageBucket = getMileageBucket(params.mileage);
  const buckets = [mileageBucket - 5000, mileageBucket, mileageBucket + 5000].filter(b => b >= 0);
  const makeUpper = params.make.toUpperCase();
  const modelUpper = params.model.toUpperCase();
  const limit = params.limit || 20;
  
  const rows = await sql`
    SELECT 
      job_title_normalized,
      MIN(job_title) as job_title,
      SUM(occurrences) as total_occurrences,
      SUM(total_labor) as sum_labor,
      SUM(total_parts) as sum_parts,
      SUM(total_amount) as sum_amount,
      MAX(last_performed) as last_performed,
      MIN(mileage_bucket) as mileage_bucket,
      COUNT(DISTINCT shop_id) as shop_count
    FROM shop_repair_patterns
    WHERE enterprise_id = ${params.enterpriseId}::uuid
      AND year = ${params.year}
      AND make = ${makeUpper}
      AND model = ${modelUpper}
      AND mileage_bucket = ANY(${buckets})
    GROUP BY job_title_normalized
    HAVING SUM(occurrences) >= 2
    ORDER BY total_occurrences DESC
    LIMIT ${limit}
  `;
  
  return rows.map((p: any) => ({
    jobTitle: p.job_title as string,
    occurrences: Number(p.total_occurrences),
    avgTotal: Math.round((Number(p.sum_amount) / Number(p.total_occurrences)) * 100) / 100,
    avgHours: 0,
    avgLabor: Math.round((Number(p.sum_labor) / Number(p.total_occurrences)) * 100) / 100,
    avgParts: Math.round((Number(p.sum_parts) / Number(p.total_occurrences)) * 100) / 100,
    lastPerformed: new Date(p.last_performed as string),
    mileageBucket: p.mileage_bucket as number,
    uniqueVehicles: Number(p.shop_count),
    confidence: Number(p.total_occurrences) >= 10 ? "high" : Number(p.total_occurrences) >= 5 ? "medium" : "low",
  }));
}

export async function setupRepairPatternsIndexes(): Promise<void> {
  console.log("Repair patterns indexes managed by PostgreSQL schema");
}
