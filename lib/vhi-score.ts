import { Db } from "mongodb";
import { type TriagedItemCache } from "@/lib/plan-cache";
import { isComplimentaryItem } from "@/lib/complimentary-classification";

export function categoryMultiplier(category: string): number {
  const cat = (category || "").toLowerCase();
  if (cat.includes("brake") || cat.includes("tire") || cat.includes("steering") || cat.includes("suspension")) return 1.5;
  if (cat.includes("engine") || cat.includes("transmission") || cat.includes("drivetrain")) return 1.3;
  if (cat.includes("wiper") || cat.includes("light") || cat.includes("cabin") || cat.includes("body")) return 0.7;
  return 1.0;
}

export function separateComplimentary(buckets: {
  overdue: TriagedItemCache[];
  dueSoon: TriagedItemCache[];
  upcoming: TriagedItemCache[];
}): {
  overdue: TriagedItemCache[];
  dueSoon: TriagedItemCache[];
  upcoming: TriagedItemCache[];
  complimentary: TriagedItemCache[];
} {
  const complimentary: TriagedItemCache[] = [];
  const filter = (items: TriagedItemCache[]) =>
    items.filter((item) => {
      if (isComplimentaryItem(item)) {
        complimentary.push(item);
        return false;
      }
      return true;
    });
  return {
    overdue: filter(buckets.overdue),
    dueSoon: filter(buckets.dueSoon),
    upcoming: filter(buckets.upcoming),
    complimentary,
  };
}

export function computeScore(buckets: { overdue: TriagedItemCache[]; dueSoon: TriagedItemCache[] }): number {
  let score = 100;

  for (const item of buckets.overdue) {
    if (isComplimentaryItem(item)) continue;
    let deduction = item.bump === "red" ? 7 : 5;
    deduction *= categoryMultiplier(item.category || "");
    if (item.declined) deduction += 1;
    score -= deduction;
  }

  for (const item of buckets.dueSoon) {
    if (isComplimentaryItem(item)) continue;
    let deduction = item.bump === "yellow" ? 2.5 : item.bump === "red" ? 3 : 2;
    deduction *= categoryMultiplier(item.category || "");
    score -= deduction;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function getScoreTier(score: number): { label: string; color: string } {
  if (score >= 90) return { label: "Excellent", color: "green" };
  if (score >= 80) return { label: "Good", color: "lime" };
  if (score >= 70) return { label: "Needs Attention", color: "amber" };
  if (score >= 60) return { label: "Poor", color: "orange" };
  return { label: "Critical", color: "red" };
}

export function formatVhiItem(item: TriagedItemCache) {
  return {
    key: item.key,
    serviceKey: item.serviceKey,
    title: item.title,
    category: item.category || null,
    intervalMiles: item.intervalMiles ?? null,
    intervalMonths: item.intervalMonths ?? null,
    last: item.last
      ? {
          miles: item.last.miles ?? null,
          date: item.last.date ?? null,
          source: item.last.source ?? null,
        }
      : null,
    dueAtMiles: item.dueAtMiles ?? null,
    dueAtDate: item.dueAtDate ?? null,
    milesToGo: item.milesToGo ?? null,
    daysToGo: item.daysToGo ?? null,
    bump: item.bump ?? null,
    source: item.source ?? null,
    dviSource: item.dviSource ?? null,
    declined: !!item.declined,
  };
}

export interface AnalysisCacheVhiResult {
  score: { value: number; tier: string; color: string };
  summary: { overdue: number; dueSoon: number; upcoming: number; complimentary?: number };
  buckets: { overdue: any[]; dueSoon: any[]; upcoming: any[]; complimentary?: any[] };
  vehicle: { year: number | null; make: string | null; model: string | null; engine: string | null };
  currentMiles: number | null;
  distanceUnit: string;
  customerName: string | null;
  cachedAt: Date;
}

const ANALYSIS_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 4; // 4 hours

export async function getVhiFromAnalysisCache(
  db: Db,
  vin: string,
  shopId: number,
  currentMiles?: number | null
): Promise<AnalysisCacheVhiResult | null> {
  const doc = await db.collection("maintenance_analysis_cache").findOne({
    vin: vin.toUpperCase(),
    shopId: { $in: [String(shopId), Number(shopId)] },
  });

  if (!doc || !doc.recommendations || !Array.isArray(doc.recommendations) || doc.recommendations.length === 0) {
    return null;
  }

  const analyzedAt = doc.analyzedAt ? new Date(doc.analyzedAt).getTime() : 0;
  if (Date.now() - analyzedAt > ANALYSIS_CACHE_MAX_AGE_MS) {
    console.log(`[VHI] Analysis cache expired for ${vin} (age: ${Math.round((Date.now() - analyzedAt) / 60000)}m)`);
    return null;
  }

  if (currentMiles != null && currentMiles > 0 && doc.mileageAtAnalysis) {
    const diff = Math.abs(currentMiles - doc.mileageAtAnalysis);
    if (diff > 500) {
      console.log(`[VHI] Analysis cache mileage stale for ${vin} (cached: ${doc.mileageAtAnalysis}, current: ${currentMiles})`);
      return null;
    }
  }

  const recs = doc.recommendations;
  const overdue = recs.filter((r: any) => r.status === "overdue");
  const dueSoon = recs.filter((r: any) => r.status === "due_soon");
  const upcoming = recs.filter((r: any) => r.status === "upcoming");

  const rawBuckets = {
    overdue: overdue.map(convertRecToTriaged),
    dueSoon: dueSoon.map(convertRecToTriaged),
    upcoming: upcoming.map(convertRecToTriaged),
  };

  const separated = separateComplimentary(rawBuckets);
  const score = computeScore(separated);
  const tier = getScoreTier(score);

  const vehicleDoc = await db.collection("vehicles").findOne(
    { vin: vin.toUpperCase(), shopId: { $in: [String(shopId), Number(shopId)] } },
    { projection: { year: 1, make: 1, model: 1, engine: 1, customerName: 1 } }
  );

  return {
    score: { value: score, tier: tier.label, color: tier.color },
    summary: {
      overdue: separated.overdue.length,
      dueSoon: separated.dueSoon.length,
      upcoming: separated.upcoming.length,
      complimentary: separated.complimentary.length,
    },
    buckets: {
      overdue: separated.overdue.map(formatVhiItem),
      dueSoon: separated.dueSoon.map(formatVhiItem),
      upcoming: separated.upcoming.map(formatVhiItem),
      complimentary: separated.complimentary.map(formatVhiItem),
    },
    vehicle: {
      year: vehicleDoc?.year ?? null,
      make: vehicleDoc?.make ?? null,
      model: vehicleDoc?.model ?? null,
      engine: vehicleDoc?.engine ?? null,
    },
    currentMiles: doc.mileageAtAnalysis ?? null,
    distanceUnit: "miles",
    customerName: vehicleDoc?.customerName ?? null,
    cachedAt: doc.analyzedAt ? new Date(doc.analyzedAt) : new Date(),
  };
}

function convertRecToTriaged(rec: any): TriagedItemCache {
  return {
    key: rec.serviceKey || rec.service || "",
    serviceKey: rec.serviceKey || "",
    title: rec.service || rec.name || "",
    category: rec.category || undefined,
    intervalMiles: rec.intervalMiles ?? rec.interval ?? null,
    intervalMonths: rec.intervalMonths ?? null,
    last: rec.last || undefined,
    dueAtMiles: rec.dueMileage ?? null,
    dueAtDate: null,
    milesToGo: rec.milesToGo ?? null,
    daysToGo: null,
    bump: rec.bump || null,
    source: rec.source === "shop" ? "oem" : rec.source === "oe" ? "oem" : rec.source === "dvi" ? "dvi" : "oem",
    dviSource: rec.dviSource || undefined,
  };
}
