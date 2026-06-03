import { getDb } from "@/lib/mongo";

export type BackfillProvider = "tekmetric" | "protractor" | "shopware";

export interface PaceConfig {
  concurrency: number;
  chunkDays: number;
  maxPagesPerChunk: number;
  maxChunksPerRun: number;
  interChunkDelayMs: number;
  isOffHours: boolean;
  shopHourLocal: number;
  shopTimezone: string;
}

const DEFAULT_TZ = "America/Chicago";

// How many years of history each provider backfill walks
// (reverse-chronological, newest-first). Shared by Tekmetric, Protractor and
// Shop-Ware so the horizon stays consistent across providers.
//
// Default 2 years (was a hard-coded 5 in each provider): because the backfill
// runs newest-first, a shorter horizon lets every shop reach `completed`
// sooner. Operators can grow or shrink it without a redeploy via the
// BACKFILL_HORIZON_YEARS env var; raising it later resumes deeper history.
// A shop whose cursor is already older than the resolved horizon flips to
// complete on its next tick (the per-provider `chunkEnd <= oldestDate` check),
// so shrinking the horizon never re-walks or errors.
export const DEFAULT_BACKFILL_YEARS = 2;

export function getBackfillYears(): number {
  const raw = Number(process.env.BACKFILL_HORIZON_YEARS);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_BACKFILL_YEARS;
}

/**
 * Compute the oldest date a backfill should walk back to, for the currently
 * resolved horizon. Shared so every provider derives the boundary identically.
 */
export function getBackfillOldestDate(now: Date = new Date()): Date {
  const oldest = new Date(now);
  oldest.setFullYear(oldest.getFullYear() - getBackfillYears());
  oldest.setHours(0, 0, 0, 0);
  return oldest;
}

/**
 * Horizon-raise reopen sweep.
 *
 * When an operator increases BACKFILL_HORIZON_YEARS, shops previously marked
 * `completed` under the shorter horizon still have history between their stored
 * cursor (`currentChunkEnd`, parked at the old oldest date) and the new, deeper
 * oldestDate. This clears their completion flags so the normal per-provider
 * selection re-includes them and the per-shop logic resumes walking backward
 * from `currentChunkEnd` — no code change or manual DB edit required.
 *
 * Guard: only reopens docs whose `currentChunkEnd` is strictly newer than the
 * freshly computed oldestDate. Because oldestDate advances forward with wall
 * time, a steady-state or shrunk horizon never satisfies this (a completed
 * shop's parked cursor is always <= the oldestDate at its completion, which is
 * <= today's oldestDate), so this is a no-op until the horizon is raised.
 *
 * `eligibleShopIds` constrains the sweep to shops the caller actually processes
 * so orphaned/unlinked progress rows aren't churned (and re-completed) every
 * tick.
 *
 * Returns the shopIds that were reopened.
 */
export async function reopenCompletedShopsForHorizon(opts: {
  db: any;
  progressCollection: string;
  providerLabel: string;
  eligibleShopIds: number[];
  shopFlagField?: string | null;
  now?: Date;
}): Promise<number[]> {
  const { db, progressCollection, providerLabel, eligibleShopIds, shopFlagField } = opts;
  if (!eligibleShopIds.length) return [];

  const years = getBackfillYears();
  const oldestDate = getBackfillOldestDate(opts.now ?? new Date());

  const candidates = await db
    .collection(progressCollection)
    .find(
      {
        shopId: { $in: eligibleShopIds },
        completed: true,
        currentChunkEnd: { $gt: oldestDate },
      },
      { projection: { shopId: 1 } },
    )
    .toArray();
  if (!candidates.length) return [];

  const ids = candidates
    .map((r: any) => Number(r.shopId))
    .filter((n: number) => Number.isFinite(n));
  if (!ids.length) return [];

  const now = new Date();
  await db.collection(progressCollection).updateMany(
    { shopId: { $in: ids } },
    {
      $set: {
        completed: false,
        complete: false,
        reopenedForHorizonAt: now,
        resolvedBackfillHorizonYears: years,
      },
      $unset: { completedAt: "" },
    },
  );
  if (shopFlagField) {
    await db.collection("shops").updateMany(
      { shopId: { $in: ids } },
      { $set: { [shopFlagField]: false } },
    );
  }
  console.log(
    `[${providerLabel}] Horizon reopen: cleared completion on ${ids.length} shop(s) to resume deeper history (horizon=${years}y): ${ids.join(",")}`,
  );
  return ids;
}

const DAY_PROFILE: Record<BackfillProvider, Omit<PaceConfig, "isOffHours" | "shopHourLocal" | "shopTimezone">> = {
  tekmetric: {
    // Bumped 2→4 after introducing the persistent /jobs cache
    // (tekmetric_jobs_cache, 30d TTL) in tekmetric-incremental-sync.ts.
    // The per-RO API fan-out used to be ~3 calls (vehicle+customer+jobs);
    // with all three now cache-backed, a warm chunk averages well under 1
    // call per RO so we can double the in-flight work without exceeding
    // Tekmetric's 600 req/min quota.
    concurrency: 4,
    chunkDays: 90,
    maxPagesPerChunk: 50,
    maxChunksPerRun: 25,
    interChunkDelayMs: 500,
  },
  protractor: {
    concurrency: 3,
    chunkDays: 60,
    maxPagesPerChunk: 50,
    maxChunksPerRun: 60,
    interChunkDelayMs: 100,
  },
  shopware: {
    concurrency: 2,
    chunkDays: 90,
    maxPagesPerChunk: 50,
    maxChunksPerRun: 4,
    interChunkDelayMs: 250,
  },
};

const NIGHT_PROFILE: Record<BackfillProvider, Omit<PaceConfig, "isOffHours" | "shopHourLocal" | "shopTimezone">> = {
  tekmetric: {
    concurrency: 5,
    chunkDays: 180,
    maxPagesPerChunk: 100,
    maxChunksPerRun: 60,
    interChunkDelayMs: 200,
  },
  protractor: {
    concurrency: 8,
    chunkDays: 120,
    maxPagesPerChunk: 100,
    maxChunksPerRun: 200,
    interChunkDelayMs: 50,
  },
  shopware: {
    concurrency: 4,
    chunkDays: 180,
    maxPagesPerChunk: 100,
    maxChunksPerRun: 12,
    interChunkDelayMs: 100,
  },
};

export function getShopHourLocal(timezone: string, now: Date = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    const h = parseInt(hourPart?.value || "12", 10);
    return Number.isFinite(h) ? h % 24 : 12;
  } catch {
    return 12;
  }
}

export function isOffHours(timezone: string, now: Date = new Date()): boolean {
  const h = getShopHourLocal(timezone, now);
  return h < 7 || h >= 19;
}

export function getPaceConfig(
  provider: BackfillProvider,
  shopTimezone?: string | null,
  now: Date = new Date()
): PaceConfig {
  const tz = shopTimezone || DEFAULT_TZ;
  const offHours = isOffHours(tz, now);
  const profile = offHours ? NIGHT_PROFILE[provider] : DAY_PROFILE[provider];
  return {
    ...profile,
    isOffHours: offHours,
    shopHourLocal: getShopHourLocal(tz, now),
    shopTimezone: tz,
  };
}

export async function getShopTimezone(shopId: number): Promise<string> {
  try {
    const db = await getDb();
    const shop = await db
      .collection("shops")
      .findOne({ shopId: { $in: [Number(shopId), String(shopId)] as any } });
    return shop?.timezone || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export interface ChunkBounds {
  start: Date;
  end: Date;
}

export function midpoint(start: Date, end: Date): Date {
  return new Date(Math.floor((start.getTime() + end.getTime()) / 2));
}

export function describePace(pace: PaceConfig): string {
  return `pace=${pace.isOffHours ? "OFF-HOURS" : "DAYTIME"} ` +
    `tz=${pace.shopTimezone} hour=${pace.shopHourLocal} ` +
    `conc=${pace.concurrency} chunkDays=${pace.chunkDays} ` +
    `maxPages=${pace.maxPagesPerChunk}`;
}
