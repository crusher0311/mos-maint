/**
 * Server-side port of snippet 01-dump-source.js.
 *
 * Pages the Job Board for ESTIMATE+WORK_IN_PROGRESS ROs, then per-RO
 * pulls the detail / estimate (jobs+parts+labor) / concerns / inspection
 * list. The output payload matches the `tekmetric-open-jobs-dump` schema
 * the snippet produced so downstream phases (load-core, load-extras) can
 * consume it unchanged.
 */
import { tekFetch, TekFetchError } from "./client";

const PAGE_SIZE = 50;
export const DUMP_SCHEMA = "tekmetric-open-jobs-dump";
export const DUMP_SCHEMA_VERSION = "2026-04-30.2-server";

const ENDPOINTS = {
  jobBoardList: (shopId: number, page: number, size: number) =>
    `/api/shop/${shopId}/repair-order?status=ESTIMATE,WORK_IN_PROGRESS&page=${page}&size=${size}&sort=updatedDate,desc`,
  repairOrderDetail: (shopId: number, roId: number) =>
    `/api/shop/${shopId}/repair-order/${roId}`,
  repairOrderEstimate: (roId: number) =>
    `/api/repair-order/${roId}/estimate`,
  repairOrderConcerns: (roId: number) =>
    `/api/repair-orders/${roId}/customer-concerns`,
  inspectionList: (shopId: number, roId: number) =>
    `/api/shop/${shopId}/repair-orders/${roId}/inspections`,
};

export interface DumpResult {
  schema: string;
  schemaVersion: string;
  dumpedAt: string;
  source: { shopId: number; shopName: string | null };
  counts: {
    ros: number;
    rosWithDetail: number;
    rosWithDumpError: number;
    jobs: number;
    inspections: number;
    concerns: number;
  };
  repairOrders: Array<{
    sourceRoId: number;
    sourceRoNumber: number | string;
    repairOrder: any;
    inspections: Array<{ id: any; title: any; jobId: any }>;
    _dumpError?: string;
  }>;
  errors: string[];
}

export interface DumpOptions {
  sourceShopId: number;
  sourceShopName?: string | null;
  token: string;
  // Optional progress callback so the audit log can record progress
  // mid-dump and the UI can poll it.
  onProgress?: (msg: { phase: string; index?: number; total?: number; detail?: string }) => Promise<void> | void;
}

export async function runDump(opts: DumpOptions): Promise<DumpResult> {
  const { sourceShopId, token } = opts;
  const errors: string[] = [];

  // 1. Page Job Board
  const summaries: any[] = [];
  let page = 0;
  while (true) {
    const path = ENDPOINTS.jobBoardList(sourceShopId, page, PAGE_SIZE);
    let resp: any;
    try {
      resp = await tekFetch(token, path);
    } catch (err: any) {
      errors.push(`Job Board listing failed at page ${page}: ${err.message}`);
      break;
    }
    const content = Array.isArray(resp)
      ? resp
      : resp?.content || resp?.repairOrders || resp?.data || [];
    if (!content.length) break;
    summaries.push(...content);
    if (opts.onProgress) {
      await opts.onProgress({
        phase: "dump.list",
        index: summaries.length,
        detail: `page ${page + 1}`,
      });
    }
    if (content.length < PAGE_SIZE) break;
    if (resp?.totalPages && page + 1 >= resp.totalPages) break;
    page++;
    if (page > 200) {
      errors.push("Hit hard cap of 200 pages — bailing out of pagination.");
      break;
    }
  }

  // 2. Per-RO detail + estimate + concerns + inspections
  const dumpedRos: DumpResult["repairOrders"] = [];
  let inspectionCount = 0;
  let jobCount = 0;
  let concernCount = 0;
  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i];
    const roId = summary.id || summary.repairOrderId;
    const roNumber = summary.repairOrderNumber || summary.number;
    try {
      const detail: any = await tekFetch(
        token,
        ENDPOINTS.repairOrderDetail(sourceShopId, roId),
      );

      let jobs: any[] = [];
      try {
        const est: any = await tekFetch(
          token,
          ENDPOINTS.repairOrderEstimate(roId),
        );
        jobs = est?.jobs || est?.repairOrderJobs || [];
      } catch (e: any) {
        errors.push(
          `estimate fetch failed for RO #${roNumber} (id=${roId}): ${e.message}`,
        );
      }

      let concerns: any[] = [];
      try {
        const c: any = await tekFetch(
          token,
          ENDPOINTS.repairOrderConcerns(roId),
        );
        concerns = Array.isArray(c) ? c : c?.data || c?.content || [];
      } catch (e: any) {
        errors.push(
          `concerns fetch failed for RO #${roNumber} (id=${roId}): ${e.message}`,
        );
      }

      let inspectionsRaw: any = [];
      try {
        inspectionsRaw = await tekFetch(
          token,
          ENDPOINTS.inspectionList(sourceShopId, roId),
        );
      } catch (e: any) {
        // non-fatal at dump-time; load-extras handles full content
        errors.push(
          `inspection list failed for RO #${roNumber} (id=${roId}): ${e.message}`,
        );
      }
      const inspectionSummaries = (
        Array.isArray(inspectionsRaw)
          ? inspectionsRaw
          : inspectionsRaw?.content || []
      ).map((ins: any) => ({
        id: ins.id,
        title: ins.title || ins.name,
        jobId: ins.jobId || null,
      }));

      detail.jobs = jobs;
      detail.customerConcerns = concerns;

      inspectionCount += inspectionSummaries.length;
      jobCount += jobs.length;
      concernCount += concerns.length;

      dumpedRos.push({
        sourceRoId: roId,
        sourceRoNumber: roNumber,
        repairOrder: detail,
        inspections: inspectionSummaries,
      });
      if ((i + 1) % 10 === 0 || i === summaries.length - 1) {
        if (opts.onProgress) {
          await opts.onProgress({
            phase: "dump.detail",
            index: i + 1,
            total: summaries.length,
            detail: `jobs=${jobCount} concerns=${concernCount} inspections=${inspectionCount}`,
          });
        }
      }
    } catch (err: any) {
      const msg =
        err instanceof TekFetchError
          ? `${err.status} ${err.message}`
          : err.message || String(err);
      errors.push(
        `Failed to fetch RO #${roNumber} (id=${roId}): ${msg}`,
      );
      dumpedRos.push({
        sourceRoId: roId,
        sourceRoNumber: roNumber,
        repairOrder: null,
        inspections: [],
        _dumpError: msg,
      });
    }
  }

  const dumpedOk = dumpedRos.filter((r) => r.repairOrder).length;
  const dumpedErr = dumpedRos.length - dumpedOk;

  return {
    schema: DUMP_SCHEMA,
    schemaVersion: DUMP_SCHEMA_VERSION,
    dumpedAt: new Date().toISOString(),
    source: {
      shopId: Number(sourceShopId),
      shopName: opts.sourceShopName || null,
    },
    counts: {
      ros: dumpedRos.length,
      rosWithDetail: dumpedOk,
      rosWithDumpError: dumpedErr,
      jobs: jobCount,
      inspections: inspectionCount,
      concerns: concernCount,
    },
    repairOrders: dumpedRos,
    errors,
  };
}
