import type { ShopHistoryGrant, ShopHistoryRequest } from "./protractor-shop-history-policy";

/** One-use approval: Afton, Tuesday October 13, 18:30–18:45 Central. */
export const AFTON_PILOT = Object.freeze({
  jobId: "afton-history-pilot-2026-10-13",
  shopId: 139,
  day: "2026-10-12",
  until: "2026-10-13",
  start: "2026-10-13T23:30:00.000Z",
  end: "2026-10-13T23:45:00.000Z",
  maxRequests: 100,
  timezone: "America/Chicago",
});
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;

export function validateAftonGrant(g: ShopHistoryGrant): void {
  if (!g || g.version !== 2 || g.shopId !== AFTON_PILOT.shopId ||
      !uuid.test(g.runId) || !uuid.test(g.canaryGeneration) || !digest.test(g.bindingDigest) ||
      g.from !== AFTON_PILOT.day || g.until !== AFTON_PILOT.until ||
      !(g.notBefore instanceof Date) || g.notBefore.getTime() !== Date.parse(AFTON_PILOT.start) ||
      !(g.expiresAt instanceof Date) || g.expiresAt.getTime() !== Date.parse(AFTON_PILOT.end) ||
      !Number.isSafeInteger(g.maxRequests) || g.maxRequests < 1 || g.maxRequests > 100 ||
      !Number.isSafeInteger(g.consumedRequests) || g.consumedRequests < 0 ||
      g.consumedRequests > g.maxRequests || typeof g.stopped !== "boolean")
    throw Error("Invalid Afton pilot permission");
}

export function aftonEndpoint(r: ShopHistoryRequest, page: number): string {
  if (r.pilot !== "afton" || r.shopId !== AFTON_PILOT.shopId || r.day !== AFTON_PILOT.day ||
      !uuid.test(r.runId) || !Number.isSafeInteger(page) || page < 0 || page >= 100)
    throw Error("Request outside Afton pilot scope");
  return `/Invoice/?startDate=${AFTON_PILOT.day}&endDate=${AFTON_PILOT.until}&take=100&skip=${page * 100}`;
}

/** All conditions and consumption run in the existing atomic fleet admission. */
export function aftonAdmissionExpression(r: ShopHistoryRequest, binding?: string): object {
  try { aftonEndpoint(r, 0); } catch { return { $literal: false }; }
  if (!binding || !digest.test(binding)) return { $literal: false };
  const p = "$aftonPilot";
  return { $cond: [{ $and: [
    { $eq: [`${p}.version`, 2] }, { $eq: [`${p}.shopId`, AFTON_PILOT.shopId] },
    { $eq: [`${p}.runId`, r.runId] }, { $eq: [`${p}.bindingDigest`, binding] },
    { $eq: [`${p}.canaryGeneration`, "$canary.generation"] },
    { $eq: [`${p}.from`, AFTON_PILOT.day] }, { $eq: [`${p}.until`, AFTON_PILOT.until] },
    { $eq: [`${p}.notBefore`, new Date(AFTON_PILOT.start)] },
    { $eq: [`${p}.expiresAt`, new Date(AFTON_PILOT.end)] },
    { $eq: [`${p}.stopped`, false] },
    { $eq: ["$canary.workersSuspendedConfirmed", true] },
    { $isNumber: `${p}.maxRequests` }, { $isNumber: `${p}.consumedRequests` },
  ] }, { $and: [
    { $lte: [`${p}.notBefore`, "$$NOW"] }, { $gt: [`${p}.expiresAt`, "$$NOW"] },
    { $gte: [`${p}.maxRequests`, 1] }, { $lte: [`${p}.maxRequests`, 100] },
    { $eq: [{ $trunc: `${p}.maxRequests` }, `${p}.maxRequests`] },
    { $gte: [`${p}.consumedRequests`, 0] },
    { $eq: [{ $trunc: `${p}.consumedRequests` }, `${p}.consumedRequests`] },
    { $lt: [`${p}.consumedRequests`, `${p}.maxRequests`] },
  ] }, false] };
}
