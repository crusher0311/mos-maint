import { blockers, DEFAULT_BRAND, elapsed, type Board, type Brand, type Job, type Visit } from "@/lib/shop-dispatch/model";
import type { DispatchSnapshot } from "@/lib/shop-dispatch/client";
import type { WorkflowBranding } from "@/lib/shop-dispatch/branding";

export type ResolvedBranding = WorkflowBranding;

/** Resolution and shared palette derivation belong to the server, not the editor. */
export function resolvedBranding(snapshot: (DispatchSnapshot & { branding?: ResolvedBranding }) | null): ResolvedBranding {
  if (snapshot?.branding) return snapshot.branding;
  // Defensive compatibility while the server/client branding contract rolls out.
  const inherited = snapshot?.enterprise?.brand ?? DEFAULT_BRAND;
  return {
    brand: snapshot?.board.locationBrand ?? inherited,
    inherited,
    source: snapshot?.board.locationBrand ? "location" : snapshot?.enterprise?.brand ? "enterprise" : "default",
    palette: "fallback",
  };
}

export const brandSourceLabel = (source: ResolvedBranding["source"]) => ({
  location: "Location override",
  shop: "Shared shop branding",
  enterprise: "Enterprise branding",
  default: "Detect Dog defaults",
})[source];

/** Shared logos are display-only here; only a manual upload may enter a new override. */
export const manualBrandDraft = (brand: Brand): Brand => ({ ...brand, logo: null });

export const localDate = (value: string | null) => value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
export const iso = (value: FormDataEntryValue | null) => value ? new Date(String(value)).toISOString() : null;
export const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not set";
export const minutes = (ms: number) => `${(ms / 60000).toFixed(1)} min`;
export const nullableNumber = (value: FormDataEntryValue | null) => value === null || value === "" ? null : Number(value);
export function contrast(hex: string) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return "#172b24";
  const rgb = hex.replace("#", "").match(/.{2}/g)!.map(v => {
    const n = parseInt(v, 16) / 255;
    return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  });
  // Black/white are text only, never workspace surfaces. Selecting the larger
  // WCAG contrast ratio guarantees >= 4.5:1 for any validated brand color.
  const luminance = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? "#000000" : "#ffffff";
}
/** Deliberately conservative, serial sum. Not a technician or rack scheduler. */
export function projection(board: Board, visit: Visit, now: number) {
  const jobs = board.jobs.filter(j => j.visitId === visit.id && j.status !== "completed");
  if (!visit.promiseAt) return "Promise unknown";
  if (!jobs.length) return "Work complete · transport still needs review";
  if (jobs.some(j => !j.estimatedMinutes || blockers(board, j).length || !j.technicianId || j.status === "paused")) return "Projection unknown";
  const baseline = Math.max(now, ...jobs.map(j => j.plannedStart ? Date.parse(j.plannedStart) : now));
  const finish = baseline + jobs.reduce((sum, j) => sum + Math.max(0, j.estimatedMinutes! * 60000 - elapsed(j, now).activeMs), 0);
  return `Limited serial projection: ${finish > Date.parse(visit.promiseAt) ? "promise at risk" : "within promise"} · ${dateLabel(new Date(finish).toISOString())}`;
}
export function canControl(board: Board, job: Job, manager: boolean, technicianId: string | null) {
  return !board.visits.find(v => v.id === job.visitId)?.closed && (manager || (!!technicianId && job.technicianId === technicianId));
}
