import type { ShopHistoryGrant, ShopHistoryRequest } from "./protractor-shop-history-policy";

/** One-use operator approval; does not change fleet quiet hours or history horizon. */
export const AVID_HISTORY = Object.freeze({
  jobId: "avid-history-2026-10-13", shopId: 457,
  from: "2024-10-14", until: "2026-10-14",
  start: "2026-10-13T22:00:00.000Z",
  end: "2026-10-14T10:55:00.000Z", // stop five minutes before 07:00 Eastern
  maxRequests: 2000, timezone: "America/New_York",
});
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
export function validateAvidGrant(g: ShopHistoryGrant): void {
  const p = AVID_HISTORY;
  if (!g || g.version !== 3 || g.shopId !== p.shopId ||
    !uuid.test(g.runId) || !uuid.test(g.canaryGeneration) || !digest.test(g.bindingDigest) ||
    g.from !== p.from || g.until !== p.until ||
    !(g.notBefore instanceof Date) || g.notBefore.getTime() !== Date.parse(p.start) ||
    !(g.expiresAt instanceof Date) || g.expiresAt.getTime() !== Date.parse(p.end) ||
    !Number.isSafeInteger(g.maxRequests) || g.maxRequests < 1 || g.maxRequests > p.maxRequests ||
    !Number.isSafeInteger(g.consumedRequests) || g.consumedRequests < 0 ||
    g.consumedRequests > g.maxRequests || typeof g.stopped !== "boolean")
    throw Error("Invalid Avid history permission");
}
export function avidEndpoint(r: ShopHistoryRequest, page: number): string {
  const p = AVID_HISTORY;
  if (r.pilot !== "avid" || r.shopId !== p.shopId || !uuid.test(r.runId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || r.day < p.from || r.day >= p.until ||
    new Date(`${r.day}T00:00:00Z`).toISOString().slice(0, 10) !== r.day ||
    !Number.isSafeInteger(page) || page < 0 || page >= 100)
    throw Error("Request outside Avid history scope");
  const end = new Date(Date.parse(`${r.day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return `/Invoice/?startDate=${r.day}&endDate=${end}&take=100&skip=${page * 100}`;
}
export function avidAdmissionExpression(r: ShopHistoryRequest, binding?: string): object {
  try { avidEndpoint(r, 0); } catch { return { $literal: false }; }
  if (!binding || !digest.test(binding)) return { $literal: false };
  const p = "$avidHistory", a = AVID_HISTORY;
  return { $cond: [{ $and: [
    { $eq: [`${p}.version`, 3] }, { $eq: [`${p}.shopId`, a.shopId] },
    { $eq: [`${p}.runId`, r.runId] }, { $eq: [`${p}.bindingDigest`, binding] },
    { $eq: [`${p}.canaryGeneration`, "$canary.generation"] },
    { $eq: [`${p}.from`, a.from] }, { $eq: [`${p}.until`, a.until] },
    { $eq: [`${p}.notBefore`, new Date(a.start)] },
    { $eq: [`${p}.expiresAt`, new Date(a.end)] },
    { $eq: [`${p}.stopped`, false] }, { $eq: ["$canary.workersSuspendedConfirmed", true] },
    { $isNumber: `${p}.maxRequests` }, { $isNumber: `${p}.consumedRequests` },
  ] }, { $and: [
    { $lte: [`${p}.notBefore`, "$$NOW"] }, { $gt: [`${p}.expiresAt`, "$$NOW"] },
    { $gte: [`${p}.maxRequests`, 1] }, { $lte: [`${p}.maxRequests`, a.maxRequests] },
    { $eq: [{ $trunc: `${p}.maxRequests` }, `${p}.maxRequests`] },
    { $gte: [`${p}.consumedRequests`, 0] },
    { $eq: [{ $trunc: `${p}.consumedRequests` }, `${p}.consumedRequests`] },
    { $lt: [`${p}.consumedRequests`, `${p}.maxRequests`] },
  ] }, false] };
}
