import { buildReportUrl } from "@/lib/report-share";

export type PartnerVhiSuccessSource =
  | "cached_plan"
  | "analysis_cache"
  | "stale_plan_rebuilding"
  | "on_demand_build";

export function buildPartnerVhiSuccessResponse<
  T extends {
    success: true;
    source: PartnerVhiSuccessSource;
  },
>(
  payload: T,
  vin: string,
  shopId: number | string,
): T & { reportUrl: string } {
  return {
    ...payload,
    reportUrl: buildReportUrl(vin, shopId),
  };
}