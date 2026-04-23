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
