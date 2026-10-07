/**
 * JWT-only background authorization contract. This is deliberately separate
 * from interactive authority. Consume its budget at the existing atomic
 * physical-dispatch boundary, never in a preliminary eligibility read.
 */
export const JWT_OVERNIGHT_POLICY_VERSION = 1;
export const JWT_OVERNIGHT_MAX_REQUESTS = 2_000;
const KEY = /^(\d{3}):(2026-(?:08|09)-\d{2})$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface JwtOvernightGrant {
  version: 1;
  runId: string;
  canaryGeneration: string;
  manifestHash: string;
  notBefore: Date;
  expiresAt: Date;
  windowKeys: string[];
  maxRequests: number;
  consumedRequests: number;
  stopped: boolean;
}

export interface JwtOvernightRequest {
  runId: string;
  shopId: number;
  day: string;
  /** Only the final-invoice daily read; not arbitrary provider reads/writes. */
  operation: "invoice-day";
  method: "GET";
}

function validWindowKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  const m = KEY.exec(key);
  if (!m) return false;
  const shopId = Number(m[1]), day = m[2];
  if (shopId < 227 || shopId > 236) return false;
  // September 701 contains both reconciled invoices and protected holds.
  if (shopId === 227 && day.startsWith("2026-09")) return false;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit",
  second: "2-digit", hourCycle: "h23",
});

/** Regular 22:00–05:00 CT window, plus one explicitly approved early start. */
function validNight(start: Date, end: Date): boolean {
  if (!(start instanceof Date) || !(end instanceof Date) ||
      !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return false;
  const duration = end.getTime() - start.getTime();
  if(start.toISOString()==="2026-10-07T23:00:00.000Z"&&end.toISOString()==="2026-10-08T10:00:00.000Z")return true;
  // Includes the fall DST transition; never an all-day or open-ended grant.
  return duration >= 6 * 3600_000 && duration <= 8 * 3600_000 &&
    start.getUTCMilliseconds() === 0 && end.getUTCMilliseconds() === 0 &&
    clock.format(start) === "22:00:00" && clock.format(end) === "05:00:00";
}

export function validateJwtOvernightGrant(grant: JwtOvernightGrant): void {
  if (!grant || grant.version !== JWT_OVERNIGHT_POLICY_VERSION ||
      typeof grant.runId !== "string" || !UUID.test(grant.runId) ||
      typeof grant.canaryGeneration !== "string" || !UUID.test(grant.canaryGeneration) ||
      typeof grant.manifestHash !== "string" || !/^[a-f0-9]{64}$/.test(grant.manifestHash) ||
      !validNight(grant.notBefore, grant.expiresAt) ||
      !Array.isArray(grant.windowKeys) || grant.windowKeys.length === 0 ||
      grant.windowKeys.length > 580 ||
      !grant.windowKeys.every(validWindowKey) ||
      new Set(grant.windowKeys).size !== grant.windowKeys.length ||
      !Number.isSafeInteger(grant.maxRequests) || grant.maxRequests < 1 ||
      grant.maxRequests > JWT_OVERNIGHT_MAX_REQUESTS ||
      (grant.notBefore.toISOString()==="2026-10-07T23:00:00.000Z"&&
       (grant.maxRequests!==1000||grant.consumedRequests<65)) ||
      !Number.isSafeInteger(grant.consumedRequests) || grant.consumedRequests < 0 ||
      grant.consumedRequests > grant.maxRequests ||
      typeof grant.stopped !== "boolean") {
    throw new Error("Invalid JWT overnight grant");
  }
}

function requestKey(request: JwtOvernightRequest): string | null {
  if (!request || typeof request.runId !== "string" || !UUID.test(request.runId) ||
      !Number.isSafeInteger(request.shopId) || typeof request.day !== "string" ||
      request.operation !== "invoice-day" || request.method !== "GET") return null;
  const key = `${request.shopId}:${request.day}`;
  return validWindowKey(key) ? key : null;
}

/** Construct the only request shape covered by this permission. */
export function compileJwtOvernightInvoiceRequest(
  request: JwtOvernightRequest,
  page: number,
): { endpoint: string; method: "GET"; shopId: number } {
  if (!requestKey(request) || !Number.isSafeInteger(page) || page < 0 || page > 4) {
    throw new Error("Invalid JWT overnight invoice request");
  }
  const nextDay = new Date(Date.parse(`${request.day}T00:00:00Z`) + 86_400_000)
    .toISOString().slice(0, 10);
  return {
    endpoint: `/Invoice/?startDate=${request.day}&endDate=${nextDay}&take=100&skip=${page * 100}`,
    method: "GET", shopId: request.shopId,
  };
}

/**
 * Recheck the actual dispatch arguments, not just the job's declared scope.
 * Exact compiled URLs reject extra filters, another day, arbitrary resources,
 * absolute URLs, encoded path tricks and duplicate query parameters.
 */
export function matchesJwtOvernightDispatch(
  request: JwtOvernightRequest,
  actual: { endpoint: string; method: string; shopId: number; body?: unknown },
): boolean {
  if (!requestKey(request) || actual.shopId !== request.shopId ||
      actual.method !== "GET" || actual.body !== undefined) return false;
  for (let page = 0; page < 5; page++) {
    if (actual.endpoint === compileJwtOvernightInvoiceRequest(request, page).endpoint) return true;
  }
  return false;
}

/** Eligibility only. This MUST NOT be used as a dispatch/consumption grant. */
export function isJwtOvernightEligible(
  grant: JwtOvernightGrant,
  request: JwtOvernightRequest,
  context: { now: Date; canaryGeneration: string; relay: boolean; production: boolean;
    operatorStopped: boolean; generalWorkersSuspended: boolean; quietWindow: boolean },
): boolean {
  try { validateJwtOvernightGrant(grant); } catch { return false; }
  const key = requestKey(request);
  return key !== null && request.runId === grant.runId &&
    context.canaryGeneration === grant.canaryGeneration &&
    context.relay === true && context.production === true &&
    context.operatorStopped === false && context.generalWorkersSuspended === true &&
    context.quietWindow === true && grant.stopped === false &&
    context.now instanceof Date &&
    context.now >= grant.notBefore && context.now < grant.expiresAt &&
    grant.consumedRequests < grant.maxRequests && grant.windowKeys.includes(key);
}

/**
 * Additional Mongo $expr constraint for the SAME physical confirmation update.
 * Caller must also retain all existing lease, relay, live-canary, stop and
 * accounting predicates. Successful confirmation must increment
 * jwtOvernight.consumedRequests in that same update, once per physical attempt.
 * Never refund an ambiguous result. This function alone authorizes nothing.
 */
export function jwtOvernightAdmissionExpression(request: JwtOvernightRequest): object {
  const key = requestKey(request);
  if (!key) return { $literal: false };
  return {
    $cond: [
      { $and: [
        { $eq: ["$jwtOvernight.version", JWT_OVERNIGHT_POLICY_VERSION] },
        { $eq: ["$jwtOvernight.runId", { $literal: request.runId }] },
        { $eq: ["$jwtOvernight.canaryGeneration", "$canary.generation"] },
        { $eq: ["$jwtOvernight.stopped", false] },
        { $eq: [{ $type: "$jwtOvernight.notBefore" }, "date"] },
        { $eq: [{ $type: "$jwtOvernight.expiresAt" }, "date"] },
        { $isArray: "$jwtOvernight.windowKeys" },
        { $isNumber: "$jwtOvernight.maxRequests" },
        { $isNumber: "$jwtOvernight.consumedRequests" },
      ] },
      { $and: [
        { $lte: ["$jwtOvernight.notBefore", "$$NOW"] },
        { $gt: ["$jwtOvernight.expiresAt", "$$NOW"] },
        { $in: [{ $literal: key }, "$jwtOvernight.windowKeys"] },
        { $gte: ["$jwtOvernight.maxRequests", 1] },
        { $lte: ["$jwtOvernight.maxRequests", JWT_OVERNIGHT_MAX_REQUESTS] },
        { $eq: [{ $trunc: "$jwtOvernight.maxRequests" }, "$jwtOvernight.maxRequests"] },
        { $gte: ["$jwtOvernight.consumedRequests", 0] },
        { $eq: [{ $trunc: "$jwtOvernight.consumedRequests" }, "$jwtOvernight.consumedRequests"] },
        { $lt: ["$jwtOvernight.consumedRequests", "$jwtOvernight.maxRequests"] },
      ] },
      false,
    ],
  };
}

/**
 * Paired update field for the existing physical confirmation pipeline. Keep
 * this in the same findOneAndUpdate that tests admission and consumes the
 * general fleet admission. Standalone reads/updates are not a safe substitute.
 */
export function jwtOvernightConsumptionFields(request: JwtOvernightRequest): object {
  return {
    "jwtOvernight.consumedRequests": {
      $cond: [
        jwtOvernightAdmissionExpression(request),
        { $add: ["$jwtOvernight.consumedRequests", 1] },
        { $ifNull: ["$jwtOvernight.consumedRequests", "$$REMOVE"] },
      ],
    },
  };
}
