import { Db } from "mongodb";
import { rebuildVhi, resolveMileageFromRo } from "@/lib/vhi-rebuild";

const activeRebuilds = new Map<string, number>();
const DEDUPE_WINDOW_MS = 30_000;

function acquireRebuildLock(key: string): boolean {
  const now = Date.now();
  const lastRun = activeRebuilds.get(key);
  if (lastRun && now - lastRun < DEDUPE_WINDOW_MS) {
    return false;
  }
  activeRebuilds.set(key, now);
  if (activeRebuilds.size > 500) {
    for (const [k, v] of activeRebuilds) {
      if (now - v > DEDUPE_WINDOW_MS * 2) activeRebuilds.delete(k);
    }
  }
  return true;
}

export interface VhiTriggerInput {
  vin: string;
  shopId: number;
  provider: string;
  roNumber?: string | null;
  mileage?: number | null;
  authorizedJobs?: string[];
  source: "webhook" | "cron" | "manual";
}

export async function triggerVhiOnWorkOrderClose(
  db: Db,
  input: VhiTriggerInput
): Promise<void> {
  const { vin, shopId, provider, roNumber, source, authorizedJobs } = input;

  if (!vin || vin.length < 11) {
    console.log(`[VHI Trigger] Skipping — invalid VIN: ${vin}`);
    return;
  }

  const lockKey = `${vin}:${shopId}:${roNumber || "any"}`;
  if (!acquireRebuildLock(lockKey)) {
    console.log(`[VHI Trigger] Skipping duplicate rebuild for ${lockKey} (within ${DEDUPE_WINDOW_MS / 1000}s window)`);
    return;
  }

  let mileage = input.mileage ?? null;

  if (!mileage || mileage <= 0) {
    mileage = await resolveMileageFromRo(db, shopId, provider, vin, roNumber);
  }

  if (!mileage || mileage <= 0) {
    console.warn(
      `[VHI Trigger] Skipping VHI rebuild for ${vin} — no mileage available from RO or vehicle record`
    );
    return;
  }

  console.log(
    `[VHI Trigger] Auto-rebuilding VHI: VIN=${vin}, shop=${shopId}, ` +
    `provider=${provider}, RO=${roNumber || "N/A"}, mileage=${mileage}, source=${source}`
  );

  try {
    const result = await rebuildVhi(shopId, vin, mileage, {
      invalidateFirst: true,
    });

    if (result.success) {
      await db.collection("vhi_analysis_log").insertOne({
        vin: vin.toUpperCase(),
        shopId,
        provider,
        roNumber: roNumber || null,
        mileage,
        score: result.score?.value,
        tier: result.score?.tier,
        summary: result.summary,
        authorizedJobs: authorizedJobs || [],
        triggeredBy: `${source}_auto`,
        analyzedAt: new Date(),
      });

      console.log(
        `[VHI Trigger] VHI rebuilt successfully: VIN=${vin}, score=${result.score?.value} (${result.score?.tier}), ` +
        `overdue=${result.summary?.overdue}, dueSoon=${result.summary?.dueSoon}, upcoming=${result.summary?.upcoming}`
      );
    } else {
      console.error(`[VHI Trigger] VHI rebuild failed for VIN=${vin}: ${result.error}`);
    }
  } catch (err: any) {
    console.error(`[VHI Trigger] Error rebuilding VHI for VIN=${vin}:`, err.message);
  }
}

export function extractAuthorizedJobsFromTekmetricRo(repairOrder: any): string[] {
  const jobs: string[] = [];
  const roParts = repairOrder?.jobs || repairOrder?.lineItems || [];
  for (const job of roParts) {
    if (
      job.authorized ||
      job.status === "approved" ||
      job.status === "authorized" ||
      job.customerAuthorized
    ) {
      const name = job.name || job.laborName || job.description || job.serviceName;
      if (name) jobs.push(name);
    }
  }
  return jobs;
}

export function extractAuthorizedJobsFromShopWareRo(roData: any): string[] {
  const jobs: string[] = [];
  const services = roData?.services || [];
  for (const svc of services) {
    if (svc.authorized || svc.state === "authorized" || svc.state === "approved") {
      const name = svc.title || svc.name || svc.description;
      if (name) jobs.push(name);
    }
  }
  return jobs;
}

export function extractAuthorizedJobsFromProtractorRo(woData: any): string[] {
  const jobs: string[] = [];
  const items = woData?.ServiceItems || woData?.data?.ServiceItems || [];
  for (const item of items) {
    if (item.Authorized || item.Status === "Authorized" || item.Status === "Approved") {
      const name = item.Description || item.Name || item.ServiceDescription;
      if (name) jobs.push(name);
    }
  }
  return jobs;
}
