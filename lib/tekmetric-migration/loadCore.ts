/**
 * Server-side port of snippet 02-load-core-dest.js.
 *
 * Walks a Snippet-1 dump and either dry-runs a plan or, with confirm=true,
 * writes the ROs/customers/vehicles/concerns/jobs into the destination
 * shop. Reuses the proven recipes:
 *   - `[migrated from RO#X]` first-concern marker for idempotency
 *   - Pre-scan dest Job Board for existing markers
 *   - Per-RO defensive recheck scoped by VIN / phone / email
 *   - Two-step job create (empty POST → populate POST with tempId-bearing
 *     parts/labor)
 *   - Auto-rollback partial RO to status DELETED on per-job failure
 *
 * The orchestrator does NOT itself download a mapping JSON; the API route
 * persists the returned `mapping` payload to Postgres.
 */
import {
  tekFetch,
  TekFetchError,
  migrationMarker,
  MIGRATION_MARKER_RE,
  normalizeApptOption,
} from "./client";

const PAGE_SIZE = 50;
export const MAPPING_SCHEMA = "tekmetric-migration-mapping";
export const MAPPING_SCHEMA_VERSION = "2026-04-30.2-server";

const ENDPOINTS = {
  jobBoardList: (shopId: number, page: number, size: number) =>
    `/api/shop/${shopId}/repair-order?status=ESTIMATE,WORK_IN_PROGRESS&page=${page}&size=${size}&sort=updatedDate,desc`,
  repairOrderDetail: (shopId: number, roId: number) =>
    `/api/shop/${shopId}/repair-order/${roId}`,
  repairOrderConcerns: (roId: number) =>
    `/api/repair-orders/${roId}/customer-concerns`,
  customerSearch: (shopId: number, q: string) =>
    `/api/shop/${shopId}/customer?search=${encodeURIComponent(q)}&page=0&size=20`,
  customerCreate: (shopId: number) => `/api/shop/${shopId}/customer`,
  vehicleSearch: (shopId: number, q: string) =>
    `/api/shop/${shopId}/vehicle?search=${encodeURIComponent(q)}&page=0&size=20`,
  vehicleCreate: (shopId: number) => `/api/shop/${shopId}/vehicle`,
  repairOrderCreate: () => `/api/repair-order/create`,
  vehicleMileage: (newRoId: number) =>
    `/api/repair-order/${newRoId}/vehicle-mileage`,
  addConcern: (newRoId: number) =>
    `/api/repair-orders/${newRoId}/customer-concerns`,
  jobCreate: (shopId: number) => `/api/shop/${shopId}/job`,
  roStatus: (roId: number) => `/api/repair-order/${roId}/status`,
  roEstimate: (roId: number) => `/api/repair-order/${roId}/estimate`,
};

// ----- two-step job create helpers (verbatim from snippet 02) ---------

function leanPart(p: any, newJobId: number) {
  const out: any = {
    tempId: Math.random(),
    jobId: newJobId,
    partType: p.partType
      ? { id: p.partType.id, code: p.partType.code }
      : { id: 1, code: "PART" },
    name: p.name ?? "",
    partNumber: p.partNumber ?? "",
    position: p.position ?? "",
    quantity: p.quantity ?? 1,
    cost: p.cost ?? 0,
    retail: p.retail ?? 0,
    oemPartNumber: p.oemPartNumber ?? "",
  };
  for (const k of [
    "brand", "description", "model", "fet", "msrp", "quote", "notes",
    "pcdbPartTypeId", "pcdbPartTypeName", "partsTechPartId", "unitOfMeasure",
    "maxCapacity", "specStandard", "warrantyLabel", "sortOrder",
    "width", "ratio", "diameter", "constructionType", "loadIndex", "speedRating",
    "tireType", "mileageWarranty", "loadRange", "tireCategory", "runFlat",
    "sideWallStyle", "treadwear", "traction", "temperature",
  ]) {
    if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
  }
  return out;
}

interface LeanLaborOptions {
  /** When true, force `technician` and `autoApplyLaborMatrixId` to null
   * (cross-shop case — those reference source-shop entities that don't
   * exist in dest). */
  crossShop?: boolean;
}

function leanLabor(l: any, newJobId: number, opts: LeanLaborOptions = {}) {
  const out: any = {
    tempId: Math.random(),
    jobId: newJobId,
    name: l.name ?? "",
    hours: l.hours ?? 0,
    rate: l.rate ?? 0,
    autoApplyLaborMatrixId: opts.crossShop
      ? null
      : (l.autoApplyLaborMatrixId ?? null),
    technician: opts.crossShop
      ? null
      : (l.technician ? { id: l.technician.id } : null),
  };
  for (const k of ["complete", "position", "warrantyLabel", "sortOrder", "sectionApplication"]) {
    if (l[k] !== undefined && l[k] !== null) out[k] = l[k];
  }
  return out;
}

export function buildPopulatePayload(
  emptyJobResp: any,
  sourceJob: any,
  opts: LeanLaborOptions = {},
) {
  const newJobId = emptyJobResp.id;
  const populated: any = { ...emptyJobResp };
  populated.name = sourceJob.name ?? populated.name;
  populated.status = sourceJob.status ?? populated.status;
  populated.selected = sourceJob.selected ?? populated.selected;
  populated.authorized = sourceJob.authorized ?? populated.authorized;
  populated.technician = opts.crossShop
    ? null
    : sourceJob.technician
      ? { id: sourceJob.technician.id }
      : null;
  populated.note = sourceJob.note ?? null;
  populated.declinedNote = sourceJob.declinedNote ?? null;
  populated.jobCategoryCode = sourceJob.jobCategoryCode ?? null;
  populated.jobCategoryName = sourceJob.jobCategoryName ?? null;
  for (const k of ["taxParts", "taxLabor", "taxFees", "taxTires", "taxTiresFet"]) {
    if (sourceJob[k] !== undefined && sourceJob[k] !== null) populated[k] = sourceJob[k];
  }
  for (const k of ["packagePrice", "packagePriceMethod", "packagePriceSurplusOilMethod", "packagePriceModsHidden", "feeable"]) {
    if (sourceJob[k] !== undefined && sourceJob[k] !== null) populated[k] = sourceJob[k];
  }
  populated.parts = (sourceJob.parts || []).map((p: any) => leanPart(p, newJobId));
  populated.labor = (sourceJob.labor || sourceJob.laborItems || []).map((l: any) => leanLabor(l, newJobId, opts));
  populated.discounts = [];
  populated.fees = [];
  populated.smartJobIds = [];
  populated.smartJobs = [];
  populated.laborTechnicians = [];
  return populated;
}

export async function createJobTwoStep(
  destShopId: number,
  newRoId: number,
  srcJob: any,
  token: string,
  opts: LeanLaborOptions = {},
) {
  const emptyPayload = {
    name: srcJob.name || "New Job",
    repairOrderId: newRoId,
    syncPartsAttachedToNonQuotedOrders: false,
  };
  const emptyJob: any = await tekFetch(token, ENDPOINTS.jobCreate(destShopId), {
    method: "POST",
    body: emptyPayload,
  });
  if (!emptyJob || !emptyJob.id) {
    throw new Error(
      `empty-create returned no id (got ${JSON.stringify(emptyJob).slice(0, 200)})`,
    );
  }
  const populatePayload = buildPopulatePayload(emptyJob, srcJob, opts);
  const populated: any = await tekFetch(
    token,
    ENDPOINTS.jobCreate(destShopId),
    { method: "POST", body: populatePayload },
  );
  return { emptyJob, populated };
}

async function rollbackPartialRo(token: string, partialRoId: number) {
  try {
    await tekFetch(token, ENDPOINTS.roStatus(partialRoId), {
      method: "PUT",
      body: { repairOrderStatus: { code: "DELETED", name: "Deleted", id: 7 } },
    });
  } catch {
    /* swallow — surfaced in the run log */
  }
}

// ----- marker scanning ------------------------------------------------

function extractMarkerFromConcernsField(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") {
    const m = field.match(MIGRATION_MARKER_RE);
    return m ? m[1] : null;
  }
  if (Array.isArray(field)) {
    for (const c of field) {
      const text = typeof c === "string" ? c : c?.concern || c?.text || "";
      const m = text.match(MIGRATION_MARKER_RE);
      if (m) return m[1];
    }
  }
  if (typeof field === "object" && field?.concern) {
    const m = field.concern.match(MIGRATION_MARKER_RE);
    return m ? m[1] : null;
  }
  return null;
}

async function fetchConcernsArray(token: string, roId: number): Promise<any[]> {
  try {
    const resp: any = await tekFetch(token, ENDPOINTS.repairOrderConcerns(roId));
    if (Array.isArray(resp)) return resp;
    if (resp && Array.isArray(resp.content)) return resp.content;
    if (resp && Array.isArray(resp.customerConcerns)) return resp.customerConcerns;
    return [];
  } catch {
    return [];
  }
}

async function preScanDestJobBoard(
  token: string,
  destShopId: number,
): Promise<Map<string, { destRoId: number; destRoNumber: any }>> {
  const alreadyMigrated = new Map<string, { destRoId: number; destRoNumber: any }>();
  const summariesNeedingDetail: Array<{ id: number; repairOrderNumber: any }> = [];
  let page = 0;
  while (true) {
    let resp: any;
    try {
      resp = await tekFetch(
        token,
        ENDPOINTS.jobBoardList(destShopId, page, PAGE_SIZE),
      );
    } catch {
      break;
    }
    const content = Array.isArray(resp)
      ? resp
      : resp?.content || resp?.repairOrders || resp?.data || [];
    if (!content.length) break;
    for (const ro of content) {
      let srcRoNum: string | null = null;
      if ("customerConcerns" in ro || "customerConcern" in ro) {
        srcRoNum = extractMarkerFromConcernsField(
          ro.customerConcerns ?? ro.customerConcern,
        );
      }
      if (srcRoNum) {
        alreadyMigrated.set(String(srcRoNum), {
          destRoId: ro.id,
          destRoNumber: ro.repairOrderNumber,
        });
      } else {
        summariesNeedingDetail.push({
          id: ro.id,
          repairOrderNumber: ro.repairOrderNumber,
        });
      }
    }
    if (content.length < PAGE_SIZE) break;
    page++;
    if (page > 200) break;
  }

  for (const s of summariesNeedingDetail) {
    let srcRoNum: string | null = null;
    try {
      const detail: any = await tekFetch(
        token,
        ENDPOINTS.repairOrderDetail(destShopId, s.id),
      );
      srcRoNum = extractMarkerFromConcernsField(
        detail.customerConcerns ?? detail.customerConcern,
      );
    } catch {
      /* fall through */
    }
    if (!srcRoNum) {
      const concerns = await fetchConcernsArray(token, s.id);
      srcRoNum = extractMarkerFromConcernsField(concerns);
    }
    if (srcRoNum) {
      alreadyMigrated.set(String(srcRoNum), {
        destRoId: s.id,
        destRoNumber: s.repairOrderNumber,
      });
    }
  }
  return alreadyMigrated;
}

// ----- VIN / phone / email defensive recheck --------------------------

async function findExistingMigratedRo(
  token: string,
  destShopId: number,
  srcRepairOrder: any,
  sourceRoNumber: any,
): Promise<{ destRoId: number; destRoNumber: any } | null> {
  const vin = srcRepairOrder?.vehicle?.vin || null;
  const cust = srcRepairOrder?.customer || {};
  const phone = (cust.phone ||
    (cust.phones && cust.phones[0] && cust.phones[0].number) ||
    "")
    .toString()
    .replace(/\D/g, "");
  const email = cust.email || "";
  const candidates: any[] = [];

  if (vin) {
    try {
      const r: any = await tekFetch(
        token,
        ENDPOINTS.vehicleSearch(destShopId, vin),
      );
      const vehicles = Array.isArray(r) ? r : r?.content || [];
      const matched = vehicles.filter(
        (v: any) => (v.vin || "").toUpperCase() === vin.toUpperCase(),
      );
      for (const v of matched) {
        try {
          const ros: any = await tekFetch(
            token,
            `/api/shop/${destShopId}/repair-order?vehicleId=${v.id}&page=0&size=50`,
          );
          const list = Array.isArray(ros)
            ? ros
            : ros?.content || ros?.repairOrders || [];
          candidates.push(...list);
        } catch {/* */}
      }
    } catch {/* */}
  }

  if (!vin && (phone || email)) {
    try {
      const q = phone || email;
      const r: any = await tekFetch(
        token,
        ENDPOINTS.customerSearch(destShopId, q),
      );
      const customers = Array.isArray(r) ? r : r?.content || [];
      for (const c of customers) {
        try {
          const ros: any = await tekFetch(
            token,
            `/api/shop/${destShopId}/repair-order?customerId=${c.id}&page=0&size=50`,
          );
          const list = Array.isArray(ros)
            ? ros
            : ros?.content || ros?.repairOrders || [];
          candidates.push(...list);
        } catch {/* */}
      }
    } catch {/* */}
  }

  if (!candidates.length) return null;

  for (const ro of candidates) {
    let foundSrcRo = extractMarkerFromConcernsField(
      ro.customerConcerns ?? ro.customerConcern,
    );
    if (!foundSrcRo) {
      try {
        const detail: any = await tekFetch(
          token,
          ENDPOINTS.repairOrderDetail(destShopId, ro.id),
        );
        foundSrcRo = extractMarkerFromConcernsField(
          detail.customerConcerns ?? detail.customerConcern,
        );
      } catch {/* */}
    }
    if (!foundSrcRo) {
      const concerns = await fetchConcernsArray(token, ro.id);
      foundSrcRo = extractMarkerFromConcernsField(concerns);
    }
    if (foundSrcRo && String(foundSrcRo) === String(sourceRoNumber)) {
      return { destRoId: ro.id, destRoNumber: ro.repairOrderNumber };
    }
  }
  return null;
}

// ----- main entry points ---------------------------------------------

export interface LoadCorePlan {
  rosInDump: number;
  rosWithDumpError: number;
  rosAlreadyMigrated: number;
  rosWillCreate: number;
  jobsWillCreate: number;
  /** ROs whose source customer/vehicle have no clear dest match — surfaced
   * to the wizard as the "Needs override" sub-list. */
  needsOverride: Array<{
    sourceRoId: number;
    sourceRoNumber: any;
    customerName: string;
    vehicle: string;
    vin: string | null;
    reason: string;
  }>;
  preview: Array<{
    sourceRo: any;
    customer: string;
    vehicle: string;
    jobs: number;
    status: "will-create" | "already-migrated" | "needs-override" | "dump-error";
  }>;
}

export interface LoadCoreOptions {
  destShopId: number;
  token: string;
  dump: any; // DumpResult shape (or imported JSON of same)
  /** Default true. Mirrors snippet flag. */
  useSourceIdsDirect?: boolean;
  /** Default true. Mirrors snippet flag. */
  autoRollbackPartialRo?: boolean;
  /** When dry-running, skip mutations and just return the plan. */
  dryRun?: boolean;
  onProgress?: (msg: { phase: string; index?: number; total?: number; detail?: string }) => Promise<void> | void;
  /** Per-RO override map: sourceRoId → { destCustomerId, destVehicleId, destLaborRateId } */
  overrides?: Record<string, { destCustomerId: number; destVehicleId: number; destLaborRateId?: number | null }>;
}

export async function planLoadCore(opts: LoadCoreOptions): Promise<LoadCorePlan> {
  const { destShopId, token, dump } = opts;
  const useSourceIdsDirect = opts.useSourceIdsDirect !== false;

  const alreadyMigrated = await preScanDestJobBoard(token, destShopId);

  const toMigrate = (dump.repairOrders || []).filter((r: any) => r.repairOrder);
  const skipped = toMigrate.filter((r: any) =>
    alreadyMigrated.has(String(r.sourceRoNumber)),
  );
  const willCreate = toMigrate.filter(
    (r: any) => !alreadyMigrated.has(String(r.sourceRoNumber)),
  );

  const needsOverride: LoadCorePlan["needsOverride"] = [];
  const preview: LoadCorePlan["preview"] = [];

  for (const r of (dump.repairOrders || [])) {
    const ro = r.repairOrder;
    if (!ro) {
      preview.push({
        sourceRo: r.sourceRoNumber,
        customer: "?",
        vehicle: "?",
        jobs: 0,
        status: "dump-error",
      });
      continue;
    }
    const customer = ro.customer
      ? `${ro.customer.firstName || ""} ${ro.customer.lastName || ""}`.trim() || "?"
      : "?";
    const vehicle = ro.vehicle
      ? `${ro.vehicle.year || ""} ${ro.vehicle.make || ""} ${ro.vehicle.model || ""}`.trim() || "?"
      : "?";
    const jobs = (ro.jobs || ro.repairOrderJobs || []).length;

    if (alreadyMigrated.has(String(r.sourceRoNumber))) {
      preview.push({
        sourceRo: r.sourceRoNumber,
        customer,
        vehicle,
        jobs,
        status: "already-migrated",
      });
      continue;
    }

    // Override detection: if not using source IDs directly AND
    // dedup-by-VIN/phone/email finds nothing, the operator must pick a
    // dest customer + vehicle by hand.
    let needsOverrideRow = false;
    let reason = "";
    if (useSourceIdsDirect) {
      // Direct mode: rely on Tekmetric's account transfer preserving IDs.
      // If the source RO is missing customer.id or vehicle.id, override needed.
      if (!ro.customer?.id || !ro.vehicle?.id) {
        needsOverrideRow = true;
        reason = "source RO missing customer.id or vehicle.id";
      }
    } else {
      // Dedup mode: try VIN / phone / email; if nothing matches, override needed.
      const vin = ro.vehicle?.vin;
      const cust = ro.customer || {};
      const phone = (cust.phone || cust.phones?.[0]?.number || "").toString().replace(/\D/g, "");
      const email = cust.email || "";
      let matched = false;
      if (vin) {
        try {
          const r2: any = await tekFetch(
            token,
            ENDPOINTS.vehicleSearch(destShopId, vin),
          );
          const list = Array.isArray(r2) ? r2 : r2?.content || [];
          matched = list.some(
            (v: any) => (v.vin || "").toUpperCase() === vin.toUpperCase(),
          );
        } catch {/* */}
      }
      if (!matched && (phone || email)) {
        try {
          const r2: any = await tekFetch(
            token,
            ENDPOINTS.customerSearch(destShopId, phone || email),
          );
          const list = Array.isArray(r2) ? r2 : r2?.content || [];
          matched = list.length > 0;
        } catch {/* */}
      }
      if (!matched) {
        needsOverrideRow = true;
        reason = vin
          ? "no dest customer/vehicle match by VIN/phone/email"
          : "source has no VIN and no phone/email";
      }
    }

    if (needsOverrideRow && !opts.overrides?.[String(r.sourceRoId)]) {
      needsOverride.push({
        sourceRoId: r.sourceRoId,
        sourceRoNumber: r.sourceRoNumber,
        customerName: customer,
        vehicle,
        vin: ro.vehicle?.vin || null,
        reason,
      });
      preview.push({
        sourceRo: r.sourceRoNumber,
        customer,
        vehicle,
        jobs,
        status: "needs-override",
      });
    } else {
      preview.push({
        sourceRo: r.sourceRoNumber,
        customer,
        vehicle,
        jobs,
        status: "will-create",
      });
    }
  }

  const totalJobs = willCreate
    .filter((r: any) => !needsOverride.find((n) => String(n.sourceRoId) === String(r.sourceRoId)))
    .reduce(
      (acc: number, r: any) =>
        acc + ((r.repairOrder.jobs || r.repairOrder.repairOrderJobs || []).length),
      0,
    );

  return {
    rosInDump: dump.repairOrders?.length || 0,
    rosWithDumpError: (dump.repairOrders?.length || 0) - toMigrate.length,
    rosAlreadyMigrated: skipped.length,
    rosWillCreate: willCreate.length,
    jobsWillCreate: totalJobs,
    needsOverride,
    preview,
  };
}

export interface LoadCoreResult {
  schema: string;
  schemaVersion: string;
  createdAt: string;
  source: any;
  dest: { shopId: number; shopName?: string | null };
  counts: {
    successes: number;
    failures: number;
    reusedAlreadyMigrated: number;
  };
  mapping: Array<{
    sourceRoId: number;
    sourceRoNumber: any;
    destRoId: number | null;
    destRoNumber: any;
    reused: boolean;
    recoveredByPerRoCheck?: boolean;
    resumedJobs?: number;
    jobMappings: Array<{
      srcJobId: any;
      srcJobName: any;
      destJobId: any;
      destJobName: any;
    }>;
  }>;
  failures: Array<{
    sourceRo: any;
    sourceRoId: number;
    step: string;
    status: any;
    error: string;
  }>;
}

export async function executeLoadCore(opts: LoadCoreOptions): Promise<LoadCoreResult> {
  const { destShopId, token, dump } = opts;
  const useSourceIdsDirect = opts.useSourceIdsDirect !== false;
  const autoRollbackPartialRo = opts.autoRollbackPartialRo !== false;

  const alreadyMigrated = await preScanDestJobBoard(token, destShopId);
  const toMigrate = (dump.repairOrders || []).filter((r: any) => r.repairOrder);
  const skipped = toMigrate.filter((r: any) =>
    alreadyMigrated.has(String(r.sourceRoNumber)),
  );
  const willCreate = toMigrate.filter(
    (r: any) => !alreadyMigrated.has(String(r.sourceRoNumber)),
  );

  const successes: any[] = [];
  const failures: LoadCoreResult["failures"] = [];
  const mapping: LoadCoreResult["mapping"] = [];

  // Reconciler for already-migrated ROs.
  async function reconcileJobsOnReusedRo(srcRepairOrder: any, destRoId: number, sourceRoNumber: any) {
    let destDetail: any;
    try {
      destDetail = await tekFetch(token, ENDPOINTS.repairOrderDetail(destShopId, destRoId));
    } catch {
      return { jobMappings: [] as any[], created: 0, missing: 0 };
    }
    const srcJobs = srcRepairOrder.jobs || srcRepairOrder.repairOrderJobs || [];
    let destJobs: any[] = destDetail.jobs || destDetail.repairOrderJobs || [];
    if (!destJobs.length) {
      try {
        const est: any = await tekFetch(token, ENDPOINTS.roEstimate(destRoId));
        destJobs = est?.jobs || est?.repairOrderJobs || [];
      } catch {/* */}
    }
    const destByName = new Map<string, any[]>();
    for (const dj of destJobs) {
      const arr = destByName.get(dj.name) || [];
      arr.push(dj);
      destByName.set(dj.name, arr);
    }
    const jobMappings: any[] = [];
    let created = 0;
    let missing = 0;
    for (let j = 0; j < srcJobs.length; j++) {
      const sj = srcJobs[j];
      const candidates = destByName.get(sj.name) || [];
      let match = candidates.shift() || null;
      if (!match) {
        missing++;
        try {
          const { populated } = await createJobTwoStep(destShopId, destRoId, sj, token);
          const id = populated?.id ?? populated?.jobId;
          match = { id, name: populated?.name };
          created++;
        } catch (jobErr: any) {
          failures.push({
            sourceRo: sourceRoNumber,
            sourceRoId: srcRepairOrder.id,
            step: `resumeMissingJob[${j}](${sj.name || "unnamed"})`,
            status: jobErr.status || "",
            error: (jobErr.body || jobErr.message || "").slice(0, 300),
          });
        }
      }
      jobMappings.push({
        srcJobId: sj.id ?? null,
        srcJobName: sj.name ?? null,
        destJobId: match?.id ?? null,
        destJobName: match?.name ?? null,
      });
    }
    return { jobMappings, created, missing };
  }

  // Pre-seed mapping with already-migrated rows.
  for (const r of skipped) {
    const hit = alreadyMigrated.get(String(r.sourceRoNumber))!;
    const recon = await reconcileJobsOnReusedRo(r.repairOrder, hit.destRoId, r.sourceRoNumber);
    mapping.push({
      sourceRoId: r.sourceRoId,
      sourceRoNumber: r.sourceRoNumber,
      destRoId: hit.destRoId,
      destRoNumber: hit.destRoNumber,
      reused: true,
      resumedJobs: recon.created,
      jobMappings: recon.jobMappings,
    });
  }

  for (let i = 0; i < willCreate.length; i++) {
    const item = willCreate[i];
    const src = item.repairOrder;
    const sourceRoNumber = item.sourceRoNumber;
    const sourceRoId = item.sourceRoId;
    let step = "start";
    try {
      step = "verifyNotAlreadyMigrated";
      const existing = await findExistingMigratedRo(token, destShopId, src, sourceRoNumber);
      if (existing) {
        const recon = await reconcileJobsOnReusedRo(src, existing.destRoId, sourceRoNumber);
        mapping.push({
          sourceRoId,
          sourceRoNumber,
          destRoId: existing.destRoId,
          destRoNumber: existing.destRoNumber,
          reused: true,
          recoveredByPerRoCheck: true,
          resumedJobs: recon.created,
          jobMappings: recon.jobMappings,
        });
        continue;
      }

      const srcCust = src.customer || {};
      const srcVeh = src.vehicle || {};
      const sourceLaborRateId =
        typeof src.laborRate === "number"
          ? src.laborRate
          : src.laborRate?.id || null;

      const override = opts.overrides?.[String(sourceRoId)];
      let destCustomerId: number | null;
      let destVehicleId: number | null;
      let destLaborRateId: number | null = override?.destLaborRateId ?? sourceLaborRateId;
      let crossShopOverride = false;

      if (override) {
        destCustomerId = override.destCustomerId;
        destVehicleId = override.destVehicleId;
        crossShopOverride = true;
      } else if (useSourceIdsDirect) {
        step = "resolveIds(direct)";
        destCustomerId = srcCust.id ?? null;
        destVehicleId = srcVeh.id ?? null;
        if (!destCustomerId || !destVehicleId) {
          throw new Error(
            `source RO is missing customer.id (${srcCust.id}) or vehicle.id (${srcVeh.id}); cannot use USE_SOURCE_IDS_DIRECT`,
          );
        }
      } else {
        // Legacy match-by-email/VIN-or-create.
        step = "matchCustomer";
        const cQuery =
          (srcCust.email && srcCust.email.trim()) ||
          (srcCust.phone?.[0]?.number || (typeof srcCust.phone === "string" ? srcCust.phone : null));
        destCustomerId = null;
        if (cQuery) {
          try {
            const r: any = await tekFetch(token, ENDPOINTS.customerSearch(destShopId, cQuery));
            const list = Array.isArray(r) ? r : r?.content || [];
            const hit = list.find(
              (c: any) =>
                (c.email && srcCust.email && c.email.toLowerCase() === srcCust.email.toLowerCase()) ||
                ((srcCust.lastName || "").toLowerCase() === (c.lastName || "").toLowerCase() &&
                  (srcCust.firstName || "").toLowerCase() === (c.firstName || "").toLowerCase()),
            );
            if (hit) destCustomerId = hit.id;
          } catch {/* */}
        }
        if (!destCustomerId) {
          step = "createCustomer";
          const created: any = await tekFetch(token, ENDPOINTS.customerCreate(destShopId), {
            method: "POST",
            body: {
              firstName: srcCust.firstName || "",
              lastName: srcCust.lastName || "",
              email: srcCust.email || null,
              phone: srcCust.phone || [],
              address: srcCust.address || null,
              customerType: srcCust.customerType || null,
              notes: srcCust.notes || null,
            },
          });
          destCustomerId = created.id;
        }
        step = "matchVehicle";
        destVehicleId = null;
        if (srcVeh.vin) {
          try {
            const r: any = await tekFetch(token, ENDPOINTS.vehicleSearch(destShopId, srcVeh.vin));
            const list = Array.isArray(r) ? r : r?.content || [];
            const hit = list.find((v: any) => (v.vin || "").toUpperCase() === srcVeh.vin.toUpperCase());
            if (hit) destVehicleId = hit.id;
          } catch {/* */}
        }
        if (!destVehicleId) {
          step = "createVehicle";
          const createdV: any = await tekFetch(token, ENDPOINTS.vehicleCreate(destShopId), {
            method: "POST",
            body: {
              customerId: destCustomerId,
              year: srcVeh.year || null,
              make: srcVeh.make || null,
              model: srcVeh.model || null,
              subModel: srcVeh.subModel || null,
              engine: srcVeh.engine || null,
              transmission: srcVeh.transmission || null,
              drivetrain: srcVeh.drivetrain || null,
              vin: srcVeh.vin || null,
              licensePlate: srcVeh.licensePlate || srcVeh.plate || null,
              color: srcVeh.color || null,
              unitNumber: srcVeh.unitNumber || null,
              notes: srcVeh.notes || null,
            },
          });
          destVehicleId = createdV.id;
        }
      }

      step = "createRo";
      const apptOption = normalizeApptOption(src.appointmentOption);
      const createPayload: any = {
        shop: { id: Number(destShopId) },
        appointmentOption: apptOption,
        odometerInop: src.odometerInop ?? false,
        leadSource: src.leadSource || "",
        vehicle: { id: destVehicleId },
        milesIn: src.milesIn ?? null,
        laborRate: destLaborRateId ? { id: destLaborRateId } : undefined,
        customer: { id: destCustomerId },
        appointment: null,
        initialJobs: [],
        recommendations: [],
        declinedJobRecommendations: [],
      };
      const createdRo: any = await tekFetch(token, ENDPOINTS.repairOrderCreate(), {
        method: "POST",
        body: createPayload,
      });
      const newRoId = createdRo.id;

      if (src.milesIn != null || src.milesOut != null) {
        step = "setMileage";
        try {
          await tekFetch(token, ENDPOINTS.vehicleMileage(newRoId), {
            method: "PUT",
            body: {
              milesIn: src.milesIn ?? src.milesOut ?? 0,
              milesOut: src.milesOut ?? src.milesIn ?? 0,
              odometerInop: src.odometerInop ?? false,
            },
          });
        } catch {/* non-fatal */}
      }

      step = "addConcerns";
      const rawConcerns = src.customerConcerns ?? src.customerConcern ?? [];
      let srcConcerns: any[];
      if (Array.isArray(rawConcerns)) {
        srcConcerns = rawConcerns
          .map((c: any) =>
            typeof c === "string" ? { concern: c } : c && typeof c === "object" ? c : null,
          )
          .filter(Boolean);
      } else if (typeof rawConcerns === "string") {
        srcConcerns = rawConcerns ? [{ concern: rawConcerns }] : [];
      } else if (rawConcerns && typeof rawConcerns === "object") {
        srcConcerns = [rawConcerns];
      } else {
        srcConcerns = [];
      }
      const concernsToPost = srcConcerns.length
        ? [
            { concern: `${migrationMarker(sourceRoNumber)} ${srcConcerns[0].concern || ""}`.trim() },
            ...srcConcerns.slice(1).map((c: any) => ({ concern: c.concern || "" })),
          ]
        : [{ concern: migrationMarker(sourceRoNumber) }];
      for (let ci = 0; ci < concernsToPost.length; ci++) {
        step = `addConcern[${ci}]`;
        await tekFetch(token, ENDPOINTS.addConcern(newRoId), {
          method: "POST",
          body: { concern: concernsToPost[ci].concern },
        });
      }

      const srcJobs = (src.jobs || src.repairOrderJobs || []).filter((j: any) => !j.archived);
      const jobMappings: any[] = [];
      for (let j = 0; j < srcJobs.length; j++) {
        const srcJob = srcJobs[j];
        step = `createJob[${j}](${srcJob.name || "unnamed"})`;
        try {
          const { populated } = await createJobTwoStep(destShopId, newRoId, srcJob, token, {
            crossShop: crossShopOverride,
          });
          const id = populated?.id ?? populated?.jobId;
          jobMappings.push({
            srcJobId: srcJob.id ?? null,
            srcJobName: srcJob.name ?? null,
            destJobId: id ?? null,
            destJobName: populated?.name ?? null,
          });
        } catch (jobErr: any) {
          if (autoRollbackPartialRo) await rollbackPartialRo(token, newRoId);
          throw new Error(`${step}: ${jobErr.message}`);
        }
      }

      successes.push({ sourceRo: sourceRoNumber, destRo: createdRo.repairOrderNumber });
      mapping.push({
        sourceRoId,
        sourceRoNumber,
        destRoId: newRoId,
        destRoNumber: createdRo.repairOrderNumber,
        reused: false,
        jobMappings,
      });
      if (opts.onProgress) {
        await opts.onProgress({
          phase: "load-core",
          index: i + 1,
          total: willCreate.length,
          detail: `#${sourceRoNumber} → #${createdRo.repairOrderNumber}`,
        });
      }
    } catch (err: any) {
      const msg =
        err instanceof TekFetchError ? `${err.status} ${err.message}` : err.message || String(err);
      failures.push({
        sourceRo: sourceRoNumber,
        sourceRoId,
        step,
        status: err.status || "",
        error: msg.slice(0, 300),
      });
    }
  }

  return {
    schema: MAPPING_SCHEMA,
    schemaVersion: MAPPING_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    source: dump.source,
    dest: { shopId: Number(destShopId) },
    counts: {
      successes: successes.length,
      failures: failures.length,
      reusedAlreadyMigrated: mapping.filter((m) => m.reused).length,
    },
    mapping,
    failures,
  };
}
