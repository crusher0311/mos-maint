/**
 * Pure Tekmetric normalization helpers shared by date-window and full-page
 * ingestion. Tekmetric money values are cents; this is the only builder layer
 * that converts job totals to canonical service-job dollars.
 */

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(source: any, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const value = finiteNumber(source?.[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export interface TekmetricNormalizedJobMoney {
  laborTotal?: number;
  partsTotal?: number;
  subletTotal?: number;
  discountTotal?: number;
  subtotal?: number;
  total?: number;
  recordedPriceAvailable: boolean;
}

export type TekmetricNormalizedJobStatus =
  | "pending"
  | "authorized"
  | "declined"
  | "in_progress"
  | "completed";

export function resolveTekmetricJobStatus(job: any): TekmetricNormalizedJobStatus {
  if (job?.authorized === false) return "declined";
  const statuses = [job?.status, job?.jobStatus, job?.authorizationStatus]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) =>
      String(value).trim().toLowerCase().replace(/[\s-]+/g, "_"),
    );
  if (statuses.some((status) => status === "declined" || status === "deferred")) {
    return "declined";
  }
  if (statuses.some((status) =>
    status === "completed" || status === "complete" || status === "performed"
  )) {
    return "completed";
  }
  if (statuses.some((status) => status === "in_progress" || status === "work_in_progress")) {
    return "in_progress";
  }
  if (statuses.some((status) => status === "authorized" || status === "approved")) {
    return "authorized";
  }
  if (job?.authorized === true) return "authorized";
  return "pending";
}

export function normalizeTekmetricJobMoney(job: any): TekmetricNormalizedJobMoney {
  const laborCents = firstNumber(job, ["laborTotal", "laborAmount", "laborPrice"]);
  const partsCents = firstNumber(job, ["partsTotal", "partsAmount", "partsPrice"]);
  const subletCents = firstNumber(job, ["subletTotal", "subletAmount", "subletPrice"]);
  const discountCents = firstNumber(job, ["discountTotal", "discountAmount"]);
  const subtotalCents = firstNumber(job, ["subtotal"]);
  const providerTotalCents = firstNumber(job, ["total", "totalAmount"]);
  const hasComponents =
    laborCents !== undefined ||
    partsCents !== undefined ||
    subletCents !== undefined ||
    discountCents !== undefined;
  const derivedCents = hasComponents
    ? (laborCents ?? 0) + (partsCents ?? 0) + (subletCents ?? 0) - (discountCents ?? 0)
    : undefined;
  const totalCents = subtotalCents ?? providerTotalCents ?? derivedCents;
  const dollars = (value: number | undefined) =>
    value === undefined ? undefined : value / 100;

  return {
    laborTotal: dollars(laborCents),
    partsTotal: dollars(partsCents),
    subletTotal: dollars(subletCents),
    discountTotal: dollars(discountCents),
    subtotal: dollars(subtotalCents),
    total: dollars(totalCents),
    recordedPriceAvailable: totalCents !== undefined,
  };
}

export function tekmetricServiceWriterName(ro: any): string | undefined {
  const direct = [
    ro?.serviceWriter?.name,
    ro?.serviceWriter?.fullName,
    ro?.serviceWriterName,
    ro?.serviceAdvisorName,
  ].find((value) => typeof value === "string" && value.trim());
  if (direct) return direct.trim();
  const joined = [
    ro?.serviceWriterAccountFirstName,
    ro?.serviceWriterAccountLastName,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ")
    .trim();
  return joined || undefined;
}

export function buildTekmetricNormalizedJob(job: any): any {
  const money = normalizeTekmetricJobMoney(job);
  return {
    ...job,
    id: job?.id,
    name: job?.name,
    status: resolveTekmetricJobStatus(job),
    authorized: typeof job?.authorized === "boolean" ? job.authorized : undefined,
    laborTotal: money.laborTotal,
    partsTotal: money.partsTotal,
    subletTotal: money.subletTotal,
    discountTotal: money.discountTotal,
    subtotal: money.subtotal,
    total: money.total,
    recordedPriceAvailable: money.recordedPriceAvailable,
  };
}

export function buildTekmetricNormalizedWorkOrder(input: {
  repairOrder: any;
  vehicle: any;
  customer: any;
  jobs: any[];
  inspections?: any[];
}): any {
  const { repairOrder: ro, vehicle, customer, jobs } = input;
  const normalizedJobs = jobs.map(buildTekmetricNormalizedJob);
  const sumCents = (fields: readonly string[]) => {
    const values = jobs.map((job) => firstNumber(job, fields)).filter((v) => v !== undefined);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
  };
  const serviceWriterName = tekmetricServiceWriterName(ro);

  return {
    ...ro,
    id: ro.id,
    repairOrderNumber: ro.repairOrderNumber,
    repairOrderStatus: ro.repairOrderStatus?.code || ro.repairOrderStatus || ro.status,
    serviceWriter: ro.serviceWriter,
    serviceWriterId: ro.serviceWriterId ?? ro.serviceWriter?.id,
    serviceWriterName,
    laborSubtotal: sumCents(["laborTotal", "laborAmount", "laborPrice"]),
    partsSubtotal: sumCents(["partsTotal", "partsAmount", "partsPrice"]),
    subletSubtotal: sumCents(["subletTotal", "subletAmount", "subletPrice"]),
    discountTotal: sumCents(["discountTotal", "discountAmount"]),
    total: sumCents(["subtotal", "total", "totalAmount"]),
    vehicle,
    customer,
    jobs: normalizedJobs,
    inspections: input.inspections || [],
    rawPayload: {
      repairOrder: ro,
      vehicle,
      customer,
      jobs,
      ...(input.inspections?.length ? { inspections: input.inspections } : {}),
    },
  };
}