export interface HistoryDay { day: number; open: string; close: string; closed: boolean }
export interface FleetHistoryConfig {
  revision: string; enabled: boolean; maxShopsPerTick: number; horizonYears: number;
  defaultTimezone: string | null; week: HistoryDay[]; rolloutShopIds: number[];
}
export const fleetHistoryDefaults = (): FleetHistoryConfig => ({
  revision: "initial", enabled: false, maxShopsPerTick: 1, horizonYears: 2,
  defaultTimezone: null, rolloutShopIds: [],
  week: Array.from({ length: 7 }, (_, day) => ({ day, open: "08:00", close: "18:00", closed: day === 0 || day === 6 })),
});
export function validTimezone(v: unknown): v is string {
  if (typeof v !== "string" || !v) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: v }).format(); return true; } catch { return false; }
}
export function validateFleetHistoryConfig(value: any): FleetHistoryConfig {
  if (!value || typeof value.revision !== "string" || typeof value.enabled !== "boolean" ||
    !Number.isInteger(value.maxShopsPerTick) || value.maxShopsPerTick < 1 || value.maxShopsPerTick > 3 ||
    !Number.isInteger(value.horizonYears) || value.horizonYears < 1 || value.horizonYears > 5 ||
    !(value.defaultTimezone === null || validTimezone(value.defaultTimezone)) ||
    !Array.isArray(value.rolloutShopIds) || value.rolloutShopIds.length > 2000 ||
    value.rolloutShopIds.some((id: any) => !Number.isSafeInteger(id) || id < 1) ||
    !Array.isArray(value.week) || value.week.length !== 7) throw new Error("Invalid fleet history settings");
  const days = new Set<number>();
  for (const row of value.week) {
    if (!Number.isInteger(row.day) || row.day < 0 || row.day > 6 || days.has(row.day) ||
      typeof row.closed !== "boolean" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.open) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.close) || (!row.closed && row.open === row.close))
      throw new Error("Specify seven valid business-hour days");
    days.add(row.day);
  }
  return { revision: value.revision, enabled: value.enabled, maxShopsPerTick: value.maxShopsPerTick,
    horizonYears: value.horizonYears, defaultTimezone: value.defaultTimezone,
    rolloutShopIds: [...new Set<number>(value.rolloutShopIds)],
    week: value.week.map((r: HistoryDay) => ({ day: r.day, open: r.open, close: r.close, closed: r.closed })) };
}
const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
function openAt(week: HistoryDay[], tz: string, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (key: string) => parts.find(p => p.type === key)?.value || "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  const today = week.find(d => d.day === day)!;
  const yesterday = week.find(d => d.day === (day + 6) % 7)!;
  const a = minutes(today.open), b = minutes(today.close);
  const prevSpill = !yesterday.closed && minutes(yesterday.open) > minutes(yesterday.close) && minute < minutes(yesterday.close);
  return prevSpill || (!today.closed && (a < b ? minute >= a && minute < b : minute >= a));
}
/** Five-minute opening margin; minute-by-minute UTC checks also handle DST. */
export function fleetHistoryWindow(config: FleetHistoryConfig, shop: any, now = new Date()): { allowed: boolean; reason: string } {
  if (!config.enabled) return { allowed: false, reason: "disabled" };
  if (config.rolloutShopIds.length && !config.rolloutShopIds.includes(Number(shop.shopId))) return { allowed: false, reason: "outside_rollout" };
  if (shop.protractor?.historyControl?.paused) return { allowed: false, reason: "paused" };
  if ([shop.status, shop.billing?.status].some(s => /^(cancelled|canceled)$/i.test(String(s ?? "")))) return { allowed: false, reason: "cancelled" };
  const tz = shop.timezone || config.defaultTimezone;
  if (!validTimezone(tz)) return { allowed: false, reason: "missing_timezone" };
  for (let i = 0; i <= 5; i++) if (openAt(config.week, tz, new Date(+now + i * 60000))) return { allowed: false, reason: "waiting_off_hours" };
  const retry = shop.protractor?.historyControl?.retryAfter;
  if (retry && +new Date(retry) > +now) return { allowed: false, reason: "retry_backoff" };
  return { allowed: true, reason: "queued" };
}
export interface FleetHistoryPermit { owner: string; shopId: number; revision: string; binding: string; generation: string; horizonYears: number }
export function fleetHistoryEndpointAllowed(endpoint: string, method: string, body: unknown): boolean {
  if (method !== "GET" || body !== undefined) return false;
  if (/^\/(?:Invoice|ServiceItem)\/[0-9a-f-]{36}$/i.test(endpoint)) return true;
  const url = new URL(endpoint, "https://history.invalid");
  if (!endpoint.startsWith("/Invoice/?") || url.origin !== "https://history.invalid" || url.pathname !== "/Invoice/" || url.hash) return false;
  const p = url.searchParams;
  if ([...p.keys()].length !== 4 || ["startDate", "endDate", "take", "skip"].some(k => p.getAll(k).length !== 1)) return false;
  const start = p.get("startDate")!, end = p.get("endDate")!;
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) &&
    Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end)) && start < end &&
    p.get("take") === "100" && /^\d+$/.test(p.get("skip")!) && Number(p.get("skip")) <= 10000;
}
/** Must be included as a mandatory AND, never a fallback permission. */
export function fleetHistoryAdmission(p: FleetHistoryPermit): object {
  if (!p || !Number.isSafeInteger(p.shopId) || p.shopId < 1 || !p.owner || !p.revision ||
    !p.generation || !/^[a-f0-9]{64}$/.test(p.binding)) return { $literal: false };
  return { $and: [
    { $eq: ["$fleetHistoryConfig.enabled", true] }, { $eq: ["$fleetHistoryConfig.revision", p.revision] },
    { $eq: ["$fleetHistoryGrant.owner", p.owner] }, { $eq: ["$fleetHistoryGrant.shopId", p.shopId] },
    { $eq: ["$fleetHistoryGrant.binding", p.binding] }, { $eq: ["$fleetHistoryGrant.generation", "$canary.generation"] },
    { $eq: ["$canary.generation", p.generation] }, { $eq: ["$canary.mode", "live"] },
    { $eq: ["$operatorStop.active", false] }, { $gt: ["$fleetHistoryGrant.expiresAt", "$$NOW"] },
    { $eq: ["$canary.mode", "live"] }, { $eq: [{ $type: "$canary.endedBy" }, "missing"] },
    { $eq: ["$fleetHistoryRunner.owner", p.owner] }, { $gt: ["$fleetHistoryRunner.expiresAt", "$$NOW"] },
    { $isNumber: "$fleetHistoryGrant.consumed" }, { $gte: ["$fleetHistoryGrant.consumed", 0] },
    { $lt: ["$fleetHistoryGrant.consumed", 500] },
  ] };
}
