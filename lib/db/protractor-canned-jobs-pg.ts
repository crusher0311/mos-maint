import sql from "@/lib/db/postgres";

export interface ProtractorCannedJob {
  id: string;
  shop_id: string | null;
  external_shop_id: number;
  job_code: string;
  job_name: string | null;
  description: string | null;
  labor_rate: number | null;
  labor_hours: number | null;
  parts: unknown[] | null;
  category: string | null;
  raw_data: Record<string, unknown> | null;
  synced_at: Date;
}

export async function upsertProtractorCannedJob(
  shopUUID: string | null,
  externalShopId: number,
  data: {
    jobCode: string;
    jobName?: string | null;
    description?: string | null;
    laborRate?: number | null;
    laborHours?: number | null;
    parts?: unknown[] | null;
    category?: string | null;
    rawData?: Record<string, unknown> | null;
  }
): Promise<ProtractorCannedJob> {
  const now = new Date();
  
  const jobs = await sql<ProtractorCannedJob[]>`
    INSERT INTO protractor_canned_jobs (
      id, shop_id, external_shop_id, job_code, job_name,
      description, labor_rate, labor_hours, parts, category,
      raw_data, synced_at
    ) VALUES (
      gen_random_uuid(),
      ${shopUUID},
      ${externalShopId},
      ${data.jobCode},
      ${data.jobName || null},
      ${data.description || null},
      ${data.laborRate || null},
      ${data.laborHours || null},
      ${data.parts ? JSON.stringify(data.parts) : '[]'}::jsonb,
      ${data.category || null},
      ${data.rawData ? JSON.stringify(data.rawData) : '{}'}::jsonb,
      ${now}
    )
    ON CONFLICT (external_shop_id, job_code)
    DO UPDATE SET
      job_name = COALESCE(EXCLUDED.job_name, protractor_canned_jobs.job_name),
      description = COALESCE(EXCLUDED.description, protractor_canned_jobs.description),
      labor_rate = COALESCE(EXCLUDED.labor_rate, protractor_canned_jobs.labor_rate),
      labor_hours = COALESCE(EXCLUDED.labor_hours, protractor_canned_jobs.labor_hours),
      parts = COALESCE(EXCLUDED.parts, protractor_canned_jobs.parts),
      category = COALESCE(EXCLUDED.category, protractor_canned_jobs.category),
      raw_data = COALESCE(EXCLUDED.raw_data, protractor_canned_jobs.raw_data),
      synced_at = ${now}
    RETURNING *
  `;
  
  return jobs[0];
}

export async function getProtractorCannedJobs(
  externalShopId: number
): Promise<ProtractorCannedJob[]> {
  return sql<ProtractorCannedJob[]>`
    SELECT * FROM protractor_canned_jobs
    WHERE external_shop_id = ${externalShopId}
    ORDER BY job_name NULLS LAST, job_code
  `;
}

export async function getProtractorCannedJobByCode(
  externalShopId: number,
  jobCode: string
): Promise<ProtractorCannedJob | null> {
  const jobs = await sql<ProtractorCannedJob[]>`
    SELECT * FROM protractor_canned_jobs
    WHERE external_shop_id = ${externalShopId} AND job_code = ${jobCode}
    LIMIT 1
  `;
  return jobs[0] || null;
}

export async function bulkUpsertProtractorCannedJobs(
  shopUUID: string | null,
  externalShopId: number,
  jobs: Array<{
    jobCode: string;
    jobName?: string | null;
    description?: string | null;
    laborRate?: number | null;
    laborHours?: number | null;
    parts?: unknown[] | null;
    category?: string | null;
    rawData?: Record<string, unknown> | null;
  }>
): Promise<void> {
  if (jobs.length === 0) return;
  
  const now = new Date();
  
  for (const job of jobs) {
    await sql`
      INSERT INTO protractor_canned_jobs (
        id, shop_id, external_shop_id, job_code, job_name,
        description, labor_rate, labor_hours, parts, category,
        raw_data, synced_at
      ) VALUES (
        gen_random_uuid(),
        ${shopUUID},
        ${externalShopId},
        ${job.jobCode},
        ${job.jobName || null},
        ${job.description || null},
        ${job.laborRate || null},
        ${job.laborHours || null},
        ${job.parts ? JSON.stringify(job.parts) : '[]'}::jsonb,
        ${job.category || null},
        ${job.rawData ? JSON.stringify(job.rawData) : '{}'}::jsonb,
        ${now}
      )
      ON CONFLICT (external_shop_id, job_code)
      DO UPDATE SET
        job_name = COALESCE(EXCLUDED.job_name, protractor_canned_jobs.job_name),
        description = COALESCE(EXCLUDED.description, protractor_canned_jobs.description),
        labor_rate = COALESCE(EXCLUDED.labor_rate, protractor_canned_jobs.labor_rate),
        labor_hours = COALESCE(EXCLUDED.labor_hours, protractor_canned_jobs.labor_hours),
        parts = COALESCE(EXCLUDED.parts, protractor_canned_jobs.parts),
        category = COALESCE(EXCLUDED.category, protractor_canned_jobs.category),
        raw_data = COALESCE(EXCLUDED.raw_data, protractor_canned_jobs.raw_data),
        synced_at = ${now}
    `;
  }
}

export async function deleteProtractorCannedJobsForShop(
  externalShopId: number
): Promise<void> {
  await sql`
    DELETE FROM protractor_canned_jobs
    WHERE external_shop_id = ${externalShopId}
  `;
}
