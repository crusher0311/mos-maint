import { type TriagedItemCache } from "@/lib/plan-cache";

export function categoryMultiplier(category: string): number {
  const cat = (category || "").toLowerCase();
  if (cat.includes("brake") || cat.includes("tire") || cat.includes("steering") || cat.includes("suspension")) return 1.5;
  if (cat.includes("engine") || cat.includes("transmission") || cat.includes("drivetrain")) return 1.3;
  if (cat.includes("wiper") || cat.includes("light") || cat.includes("cabin") || cat.includes("body")) return 0.7;
  return 1.0;
}

export function computeScore(buckets: { overdue: TriagedItemCache[]; dueSoon: TriagedItemCache[] }): number {
  let score = 100;

  for (const item of buckets.overdue) {
    let deduction = item.bump === "red" ? 7 : 5;
    deduction *= categoryMultiplier(item.category || "");
    if (item.declined) deduction += 1;
    score -= deduction;
  }

  for (const item of buckets.dueSoon) {
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
