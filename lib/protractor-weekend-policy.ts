import type { ShopHistoryGrant, ShopHistoryRequest } from "./protractor-shop-history-policy";

// This is a one-use operator-approved campaign, not an unrestricted fleet switch.
export const WEEKEND = Object.freeze({
  id: "protractor-weekend-2026-10-17",
  start: "2026-10-17T00:00:00.000Z",
  end: "2026-10-19T10:00:00.000Z",
  until: "2026-10-17",
  maxRequests: 10000,
  quietMs: 60 * 60000,
  evidenceMs: 7 * 86400000,
});
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
export const weekendFrom = (shopId: number) => shopId === 538 ? "2025-08-17" : "2024-10-17";
export function weekendEndpoint(r: ShopHistoryRequest, page: number): string {
  if (r.pilot !== "weekend" || !Number.isSafeInteger(r.shopId) || r.shopId < 1 ||
      !uuid.test(r.runId) || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) ||
      r.day < weekendFrom(r.shopId) || r.day >= WEEKEND.until ||
      new Date(`${r.day}T00:00:00Z`).toISOString().slice(0, 10) !== r.day ||
      !Number.isSafeInteger(page) || page < 0 || page >= 100)
    throw Error("Request outside weekend history scope");
  const end = new Date(Date.parse(r.day) + 86400000).toISOString().slice(0, 10);
  return `/Invoice/?startDate=${r.day}&endDate=${end}&take=100&skip=${page * 100}`;
}
export function validateWeekendGrant(g: ShopHistoryGrant): void {
  if (!g || g.version !== 4 || !Number.isSafeInteger(g.shopId) || g.shopId < 1 ||
      !uuid.test(g.runId) || !uuid.test(g.canaryGeneration) || !digest.test(g.bindingDigest) ||
      g.from !== weekendFrom(g.shopId) || g.until !== WEEKEND.until ||
      !(g.notBefore instanceof Date) || g.notBefore.toISOString() !== WEEKEND.start ||
      !(g.expiresAt instanceof Date) || g.expiresAt.toISOString() !== WEEKEND.end ||
      !Number.isSafeInteger(g.maxRequests) || g.maxRequests < 1 || g.maxRequests > WEEKEND.maxRequests ||
      !Number.isSafeInteger(g.consumedRequests) || g.consumedRequests < 0 ||
      g.consumedRequests > g.maxRequests || typeof g.stopped !== "boolean")
    throw Error("Invalid weekend history permission");
}
/** Unknown/silent connections never qualify solely by their silence. */
export function callbackQuietEvidence(times: Date[], now: Date): boolean {
  const valid = times.map(t => t.getTime()).filter(t =>
    Number.isFinite(t) && t <= now.getTime() && t >= now.getTime() - WEEKEND.evidenceMs);
  return valid.length >= 3 &&
    new Set(valid.map(t => new Date(t).toISOString().slice(0, 10))).size >= 2 &&
    Math.max(...valid) <= now.getTime() - WEEKEND.quietMs;
}
/** Rechecked atomically at every physical dispatch; no budget refunds. */
export function weekendAdmissionExpression(r: ShopHistoryRequest, binding?: string): object {
  try { weekendEndpoint(r, 0); } catch { return { $literal: false }; }
  if (!binding || !digest.test(binding)) return { $literal: false };
  const p = "$weekendHistory";
  return { $cond: [{ $and: [
    { $eq: [`${p}.version`, 4] }, { $eq: [`${p}.shopId`, r.shopId] },
    { $eq: [`${p}.runId`, r.runId] }, { $eq: [`${p}.bindingDigest`, binding] },
    { $eq: [`${p}.canaryGeneration`, "$canary.generation"] },
    { $eq: [`${p}.from`, weekendFrom(r.shopId)] }, { $eq: [`${p}.until`, WEEKEND.until] },
    { $eq: [`${p}.notBefore`, new Date(WEEKEND.start)] },
    { $eq: [`${p}.expiresAt`, new Date(WEEKEND.end)] },
    { $eq: [`${p}.stopped`, false] }, { $eq: ["$canary.workersSuspendedConfirmed", true] },
    { $isNumber: `${p}.maxRequests` }, { $isNumber: `${p}.consumedRequests` },
    { $eq: [{ $type: `${p}.activityCheckedAt` }, "date"] },
    { $eq: [{ $type: `${p}.runnerLeaseUntil` }, "date"] },
  ] }, { $and: [
    { $lte: [`${p}.notBefore`, "$$NOW"] }, { $gt: [`${p}.expiresAt`, "$$NOW"] },
    { $gt: [`${p}.runnerLeaseUntil`, "$$NOW"] },
    { $gte: [`${p}.activityCheckedAt`, { $subtract: ["$$NOW", 15000] }] },
    { $lte: [`${p}.activityCheckedAt`, "$$NOW"] },
    { $gte: [`${p}.maxRequests`, 1] }, { $lte: [`${p}.maxRequests`, WEEKEND.maxRequests] },
    { $eq: [{ $trunc: `${p}.maxRequests` }, `${p}.maxRequests`] },
    { $gte: [`${p}.consumedRequests`, 0] },
    { $eq: [{ $trunc: `${p}.consumedRequests` }, `${p}.consumedRequests`] },
    { $lt: [`${p}.consumedRequests`, `${p}.maxRequests`] },
  ] }, false] };
}
