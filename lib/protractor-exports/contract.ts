import { createHash } from "node:crypto";

export const PAGE_SIZE = 25;
export const MAX_BODY_BYTES = 512 * 1024;
export const COVERAGE = {
  scope: "MOS-observed latest provider snapshots",
  completeProviderHistory: false,
  intermediateChanges: false,
  deletionDetection: false,
  dviIncluded: false,
} as const;
export type Entity = "work_order" | "invoice";
export interface ExportConfig {
  _id: string;
  revision: number;
  destination: string;
  shopIds: number[];
  timeZone: string;
  dailyTime: string;
  initialSnapshot: boolean;
  paused: boolean;
  revoked: boolean;
  confirmedAt: string;
  approvedBy: string;
  secret: string;
}
export interface Snapshot {
  shopId: number;
  entityType: Entity;
  providerId: string;
  observedAt: string;
  source: string;
  payload: Record<string, unknown>;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
/** Payload only: observation/refetch time and cache wrapper never cause changes. */
export const snapshotHash = (s: Snapshot) => digest(s.payload);
export function validateSettings(input: any) {
  const shopIds = input.shopIds;
  if (!Array.isArray(shopIds) || !shopIds.length || shopIds.length > 50 ||
      shopIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(shopIds).size !== shopIds.length) throw new Error("Select 1–50 distinct approved shops");
  if (typeof input.timeZone !== "string") throw new Error("Timezone required");
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(); }
  catch { throw new Error("Invalid timezone"); }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.dailyTime)) throw new Error("Invalid daily time");
  if (typeof input.initialSnapshot !== "boolean" || input.redistributionApproved !== true ||
      input.contractConfirmed !== true) throw new Error("Explicit redistribution and contract confirmation required");
  return { shopIds: shopIds as number[], timeZone: input.timeZone as string,
    dailyTime: input.dailyTime as string, initialSnapshot: input.initialSnapshot as boolean };
}
/** Once per local date; nonexistent spring hour runs at first later tick.
 * Repeated fall hour has the same date identity and cannot create two windows. */
export function dueDate(now: Date, timeZone: string, dailyTime: string): string | null {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.hour}:${parts.minute}` >= dailyTime
    ? `${parts.year}-${parts.month}-${parts.day}` : null;
}
