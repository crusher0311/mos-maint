import { buildReportUrl } from "@/lib/report-share";

export type PartnerVhiSuccessSource =
  | "cached_plan"
  | "analysis_cache"
  | "stale_plan_rebuilding"
  | "on_demand_build";

type PartnerBuckets = Record<"overdue" | "dueSoon" | "upcoming" | "complimentary", any[]>;

function combineText(a: unknown, b: unknown): string | null {
  const values = Array.from(
    new Set([a, b].map((value) => String(value ?? "").trim()).filter(Boolean)),
  ).sort();
  return values.length > 0 ? values.join(" • ") : null;
}

/**
 * Defensive response-boundary collapse for legacy snapshots and fresh plans.
 * Bucket order is severity order, so the first occurrence determines placement.
 */
export function dedupePartnerVhiBuckets(buckets: Partial<PartnerBuckets> | null | undefined): PartnerBuckets {
  const result: PartnerBuckets = { overdue: [], dueSoon: [], upcoming: [], complimentary: [] };
  const seen = new Map<string, any>();

  for (const bucket of ["overdue", "dueSoon", "upcoming", "complimentary"] as const) {
    for (const item of Array.isArray(buckets?.[bucket]) ? buckets![bucket]! : []) {
      const identity = String(item?.serviceKey ?? item?.key ?? "").trim();
      if (!identity) {
        result[bucket].push(item);
        continue;
      }
      const existing = seen.get(identity);
      if (!existing) {
        const copy = { ...item };
        seen.set(identity, copy);
        result[bucket].push(copy);
        continue;
      }
      if (item?.bump === "red") existing.bump = "red";
      else if (item?.bump === "yellow" && !existing.bump) existing.bump = "yellow";
      existing.notes = combineText(existing.notes, item?.notes);
      existing.detail = combineText(existing.detail, item?.detail);
      const sources = [existing.dviSource, item?.dviSource].filter(Boolean).sort();
      if (sources.length > 0) existing.dviSource = sources[0];
    }
  }
  return result;
}

export function buildPartnerVhiSuccessResponse<
  T extends {
    success: true;
    source: PartnerVhiSuccessSource;
    buckets?: Partial<PartnerBuckets>;
    summary?: Record<string, number>;
  },
>(
  payload: T,
  vin: string,
  shopId: number | string,
): T & { reportUrl: string } {
  const buckets = payload.buckets ? dedupePartnerVhiBuckets(payload.buckets) : undefined;
  const summary = buckets
    ? {
        ...payload.summary,
        overdue: buckets.overdue.length,
        dueSoon: buckets.dueSoon.length,
        upcoming: buckets.upcoming.length,
        complimentary: buckets.complimentary.length,
      }
    : payload.summary;
  return {
    ...payload,
    ...(buckets ? { buckets } : {}),
    ...(summary ? { summary } : {}),
    reportUrl: buildReportUrl(vin, shopId),
  } as T & { reportUrl: string };
}