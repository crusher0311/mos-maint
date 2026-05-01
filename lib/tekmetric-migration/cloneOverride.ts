/**
 * Server-side port of snippet 06-clone-ro-cross-shop-with-overrides.js.
 *
 * Used as the "Needs override" sub-list action in the wizard: clone a single
 * source RO into the dest shop attached to an EXISTING dest customer +
 * vehicle (the source customer/vehicle aren't recreated). Forces null
 * technician + autoApplyLaborMatrixId since those reference source-shop
 * entities that don't exist in dest.
 *
 * Returns either a dry-run plan or a real `{ destRoId, destRoNumber, jobs }`
 * payload that the API route then merges into the run mapping.
 */
import {
  tekFetch,
  TekFetchError,
  migrationMarker,
  normalizeApptOption,
} from "./client";
import { createJobTwoStep } from "./loadCore";

const ENDPOINTS = {
  shopProbe: (shopId: number) => `/api/shop/${shopId}`,
  customerGet: (shopId: number, customerId: number) =>
    `/api/shop/${shopId}/customer/${customerId}`,
  vehicleGet: (shopId: number, vehicleId: number) =>
    `/api/shop/${shopId}/vehicle/${vehicleId}`,
  recentRos: (shopId: number) =>
    `/api/shop/${shopId}/repair-order?page=0&size=10`,
  roDetail: (shopId: number, roId: number) =>
    `/api/shop/${shopId}/repair-order/${roId}`,
  roEstimate: (roId: number) => `/api/repair-order/${roId}/estimate`,
  roConcerns: (roId: number) => `/api/repair-orders/${roId}/customer-concerns`,
  roCreate: () => `/api/repair-order/create`,
  roMileage: (roId: number) => `/api/repair-order/${roId}/vehicle-mileage`,
  roStatus: (roId: number) => `/api/repair-order/${roId}/status`,
  addConcern: (roId: number) => `/api/repair-orders/${roId}/customer-concerns`,
};

export interface CloneOverrideOptions {
  sourceShopId: number;
  sourceRoId: number;
  destShopId: number;
  destCustomerId: number;
  destVehicleId: number;
  destLaborRateId?: number | null;
  sourceToken: string;
  destToken: string;
  confirm?: boolean;
  jobsLimit?: number | null;
  autoRollback?: boolean;
}

export interface CloneOverrideResult {
  dryRun: boolean;
  plan: {
    sourceRoNumber: any;
    destCustomer: { id: number; firstName?: string; lastName?: string };
    destVehicle: { id: number; year?: any; make?: any; model?: any; vin?: any };
    destLaborRateId: number;
    milesIn?: any;
    milesOut?: any;
    concerns: string[];
    jobs: Array<{ name: string; parts: number; labor: number; status: any }>;
  };
  result?: {
    destRoId: number;
    destRoNumber: any;
    destRoUrl: string;
    jobMappings: Array<{
      srcJobId: any;
      srcJobName: any;
      destJobId: any;
      destJobName: any;
    }>;
    failures: Array<{ step: string; error: string }>;
  };
}

export async function cloneRoWithOverride(
  opts: CloneOverrideOptions,
): Promise<CloneOverrideResult> {
  const {
    sourceShopId,
    sourceRoId,
    destShopId,
    destCustomerId,
    destVehicleId,
    sourceToken,
    destToken,
  } = opts;
  const confirm = opts.confirm === true;
  const autoRollback = opts.autoRollback !== false;

  // --- Pre-flight tokens + dest customer/vehicle
  await tekFetch(sourceToken, ENDPOINTS.shopProbe(sourceShopId));
  await tekFetch(destToken, ENDPOINTS.shopProbe(destShopId));

  const destCust: any = await tekFetch(
    destToken,
    ENDPOINTS.customerGet(destShopId, destCustomerId),
  );
  if (!destCust?.id) {
    throw new Error(`dest customer ${destCustomerId} not found in shop ${destShopId}`);
  }
  const destVeh: any = await tekFetch(
    destToken,
    ENDPOINTS.vehicleGet(destShopId, destVehicleId),
  );
  if (!destVeh?.id) {
    throw new Error(`dest vehicle ${destVehicleId} not found in shop ${destShopId}`);
  }

  // --- Resolve dest labor rate (auto-discover if not set)
  let destLaborRateId = opts.destLaborRateId ?? null;
  if (!destLaborRateId) {
    const recent: any = await tekFetch(destToken, ENDPOINTS.recentRos(destShopId));
    const list = Array.isArray(recent)
      ? recent
      : recent?.content || recent?.repairOrders || recent?.data || [];
    for (const ro of list) {
      const lr = typeof ro.laborRate === "number" ? ro.laborRate : ro.laborRate?.id;
      if (lr) {
        destLaborRateId = lr;
        break;
      }
    }
    if (!destLaborRateId) {
      throw new Error(
        `could not auto-discover a labor rate id from any recent RO in dest shop ${destShopId}; supply destLaborRateId`,
      );
    }
  }

  // --- Source RO + estimate + concerns
  const sourceRo: any = await tekFetch(
    sourceToken,
    ENDPOINTS.roDetail(sourceShopId, sourceRoId),
  );
  const sourceEstimate: any = await tekFetch(
    sourceToken,
    ENDPOINTS.roEstimate(sourceRoId),
  );
  const sourceJobs: any[] = (sourceEstimate?.jobs || []).filter((j: any) => !j.archived);
  const sourceConcernsRaw: any = await tekFetch(
    sourceToken,
    ENDPOINTS.roConcerns(sourceRoId),
  );
  const sourceConcerns: any[] = Array.isArray(sourceConcernsRaw)
    ? sourceConcernsRaw
    : sourceConcernsRaw?.data || sourceConcernsRaw?.content || [];

  const concernsToPost = sourceConcerns.length
    ? [
        {
          concern: `${migrationMarker(sourceRo.repairOrderNumber)} ${sourceConcerns[0].concern || ""}`.trim(),
        },
        ...sourceConcerns.slice(1).map((c: any) => ({ concern: c.concern || "" })),
      ]
    : [{ concern: migrationMarker(sourceRo.repairOrderNumber) }];

  const jobsToClone = opts.jobsLimit ? sourceJobs.slice(0, opts.jobsLimit) : sourceJobs;

  const plan: CloneOverrideResult["plan"] = {
    sourceRoNumber: sourceRo.repairOrderNumber,
    destCustomer: {
      id: destCust.id,
      firstName: destCust.firstName,
      lastName: destCust.lastName,
    },
    destVehicle: {
      id: destVeh.id,
      year: destVeh.year,
      make: destVeh.make,
      model: destVeh.model,
      vin: destVeh.vin,
    },
    destLaborRateId,
    milesIn: sourceRo.milesIn,
    milesOut: sourceRo.milesOut,
    concerns: concernsToPost.map((c) => c.concern),
    jobs: jobsToClone.map((j: any) => ({
      name: j.name,
      parts: j.parts?.length || 0,
      labor: (j.labor || j.laborItems || []).length,
      status: j.status,
    })),
  };

  if (!confirm) {
    return { dryRun: true, plan };
  }

  // --- Create RO
  const createPayload = {
    shop: { id: Number(destShopId) },
    appointmentOption: normalizeApptOption(sourceRo.appointmentOption),
    odometerInop: sourceRo.odometerInop ?? false,
    leadSource: sourceRo.leadSource || "",
    vehicle: { id: destVehicleId },
    milesIn: sourceRo.milesIn ?? null,
    laborRate: { id: destLaborRateId },
    customer: { id: destCustomerId },
    appointment: null,
    initialJobs: [],
    recommendations: [],
    declinedJobRecommendations: [],
  };
  const newRo: any = await tekFetch(destToken, ENDPOINTS.roCreate(), {
    method: "POST",
    body: createPayload,
  });
  const newRoId = newRo.id;
  const newRoUrl = `https://shop.tekmetric.com/admin/shop/${destShopId}/repair-orders/${newRoId}/estimate`;

  const failures: Array<{ step: string; error: string }> = [];

  // --- Mileage
  if (sourceRo.milesIn != null || sourceRo.milesOut != null) {
    try {
      await tekFetch(destToken, ENDPOINTS.roMileage(newRoId), {
        method: "PUT",
        body: {
          milesIn: sourceRo.milesIn ?? sourceRo.milesOut ?? 0,
          milesOut: sourceRo.milesOut ?? sourceRo.milesIn ?? 0,
          odometerInop: sourceRo.odometerInop ?? false,
        },
      });
    } catch (e: any) {
      failures.push({ step: "setMileage", error: e.message });
    }
  }

  // --- Concerns
  for (let i = 0; i < concernsToPost.length; i++) {
    try {
      await tekFetch(destToken, ENDPOINTS.addConcern(newRoId), {
        method: "POST",
        body: { concern: concernsToPost[i].concern },
      });
    } catch (e: any) {
      failures.push({ step: `addConcern[${i}]`, error: e.message });
    }
  }

  // --- Jobs (TWO-STEP, crossShop=true to null tech + matrix)
  const jobMappings: any[] = [];
  for (let i = 0; i < jobsToClone.length; i++) {
    const job = jobsToClone[i];
    const step = `createJob[${i}](${job.name || "unnamed"})`;
    try {
      const { populated } = await createJobTwoStep(destShopId, newRoId, job, destToken, {
        crossShop: true,
      });
      jobMappings.push({
        srcJobId: job.id ?? null,
        srcJobName: job.name ?? null,
        destJobId: populated?.id ?? populated?.jobId ?? null,
        destJobName: populated?.name ?? null,
      });
    } catch (e: any) {
      const msg = e instanceof TekFetchError ? `${e.status} ${e.message}` : e.message;
      failures.push({ step, error: msg.slice(0, 300) });
      if (autoRollback) {
        try {
          await tekFetch(destToken, ENDPOINTS.roStatus(newRoId), {
            method: "PUT",
            body: {
              repairOrderStatus: { code: "DELETED", name: "Deleted", id: 7 },
            },
          });
        } catch {/* */}
      }
      return {
        dryRun: false,
        plan,
        result: {
          destRoId: newRoId,
          destRoNumber: newRo.repairOrderNumber,
          destRoUrl: newRoUrl,
          jobMappings,
          failures,
        },
      };
    }
  }

  return {
    dryRun: false,
    plan,
    result: {
      destRoId: newRoId,
      destRoNumber: newRo.repairOrderNumber,
      destRoUrl: newRoUrl,
      jobMappings,
      failures,
    },
  };
}
