import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { CarfaxReport } from "@/lib/integrations/carfax";

/**
 * Server-only handoff for the AppFueled ingest -> VHI build.  This is
 * deliberately not represented by a header/query parameter: a client must
 * never be able to select the report used by plan-build.
 */
export type AppFueledDirectVhiContext = {
  shopId: number;
  vin: string;
  /** Canonical, accepted CARFAX snapshot supplied by the ingestion boundary. */
  carfaxReport: CarfaxReport;
  /** Stable revision used only for observability/coalescing by callers. */
  reportRevision?: string;
  /** Internal orchestration hint; never populated from HTTP input. */
  planCacheMissKnown?: boolean;
};

const storage = new AsyncLocalStorage<AppFueledDirectVhiContext>();

export function runWithAppFueledDirectVhiContext<T>(
  context: AppFueledDirectVhiContext,
  callback: () => T,
): T {
  return storage.run({ ...context, vin: context.vin.toUpperCase() }, callback);
}

export function getAppFueledDirectVhiContext(): AppFueledDirectVhiContext | undefined {
  return storage.getStore();
}

export function getTrustedAppFueledReport(
  shopId: number,
  vin: string | undefined,
): CarfaxReport | undefined {
  if (!vin) return undefined;
  const context = storage.getStore();
  const expectedVin = vin.toUpperCase();
  if (!context || context.shopId !== shopId || context.vin !== expectedVin) return undefined;
  const reportVin = context.carfaxReport.vin?.toUpperCase();
  return reportVin && reportVin !== expectedVin ? undefined : context.carfaxReport;
}

export function markAppFueledPlanCacheMiss(): void {
  const context = storage.getStore();
  if (context) context.planCacheMissKnown = true;
}

export function isAppFueledDirectVhiEnabled(): boolean {
  return process.env.APPFUELED_DIRECT_VHI_ENABLED === "true";
}

export function acceptedCarfaxReportRevision(report: CarfaxReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex").slice(0, 20);
}