import sql from "@/lib/db/postgres";

export interface JobIndexEntry {
  id: string;
  shop_id: string;
  vin: string | null;
  work_order_id: string | null;
  job_title: string | null;
  job_label: string | null;
  keywords: string[] | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_year: number | null;
  labor_amount: number | null;
  parts_amount: number | null;
  total_amount: number | null;
  labor_hours: number | null;
  performed_at: Date | null;
  closed_at: Date | null;
  customer: Record<string, unknown> | null;
  job: Record<string, unknown> | null;
  lines: unknown[] | null;
  totals: Record<string, unknown> | null;
  content_hash: string | null;
  created_at: Date;
}

export async function findCachedJobPricing(
  shopUUID: string,
  options: {
    serviceItemId?: string;
    vin?: string;
    jobTitle?: string;
    jobCode?: string;
  }
): Promise<{
  found: boolean;
  lines?: Array<{
    lineType: string;
    description: string;
    partNumber?: string;
    manufacturer?: string;
    quantity: number;
    unitPrice: number;
    extendedPrice: number;
  }>;
  source?: string;
  workOrderNumber?: number;
  performedAt?: Date;
}> {
  const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetTitle = options.jobTitle ? normalize(options.jobTitle) : '';
  const targetCode = options.jobCode ? normalize(options.jobCode) : '';
  
  if (!options.vin && !options.serviceItemId) {
    console.log(`[Job Index PG] No VIN or serviceItemId provided for job lookup`);
    return { found: false };
  }
  
  const normalizedVin = options.vin?.toUpperCase().trim() || null;
  
  let jobs: JobIndexEntry[];
  
  if (normalizedVin) {
    jobs = await sql<JobIndexEntry[]>`
      SELECT * FROM job_index
      WHERE shop_id = ${shopUUID}
      AND vin = ${normalizedVin}
      ORDER BY performed_at DESC NULLS LAST
      LIMIT 100
    `;
  } else {
    jobs = await sql<JobIndexEntry[]>`
      SELECT * FROM job_index
      WHERE shop_id = ${shopUUID}
      ORDER BY performed_at DESC NULLS LAST
      LIMIT 100
    `;
  }
  
  console.log(`[Job Index PG] Found ${jobs.length} cached jobs for vehicle (shopId: ${shopUUID}, vin: ${options.vin || 'N/A'})`);
  
  if (jobs.length === 0) {
    return { found: false };
  }
  
  for (const job of jobs) {
    const jobData = job.job as Record<string, unknown> | null;
    const jobTitle = (jobData?.title as string) || job.job_title || '';
    const jobCode = (jobData?.code as string) || '';
    const normalizedJobTitle = normalize(jobTitle);
    const normalizedJobCode = normalize(jobCode);
    
    let matched = false;
    let matchType = '';
    
    if (targetCode && normalizedJobCode === targetCode) {
      matched = true;
      matchType = 'exact code';
    } else if (targetTitle && normalizedJobTitle === targetTitle) {
      matched = true;
      matchType = 'exact title';
    } else if (targetTitle && targetTitle.length > 5 && normalizedJobTitle.includes(targetTitle)) {
      matched = true;
      matchType = 'partial title';
    }
    
    const lines = job.lines as Array<Record<string, unknown>> | null;
    if (matched && lines && lines.length > 0) {
      console.log(`[Job Index PG] Found matching job (${matchType}): "${jobTitle}" with ${lines.length} lines`);
      
      const protractorLines = lines.map((line) => ({
        lineType: line.lineType === 'labor' ? 'Labor' : 'Material',
        description: (line.description as string) || '',
        partNumber: (line.partNumber as string) || undefined,
        manufacturer: (line.manufacturer as string) || undefined,
        quantity: (line.quantity as number) || 1,
        unitPrice: (line.unitPrice as number) || 0,
        extendedPrice: (line.extendedPrice as number) || 0,
      }));
      
      return {
        found: true,
        lines: protractorLines,
        source: `cached from job_index`,
        workOrderNumber: job.work_order_id ? parseInt(job.work_order_id, 10) : undefined,
        performedAt: job.performed_at || undefined,
      };
    }
  }
  
  console.log(`[Job Index PG] No matching job found for "${options.jobTitle}" (code: ${options.jobCode})`);
  return { found: false };
}
