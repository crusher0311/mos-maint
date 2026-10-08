import { blockers, elapsed, type Board, type Job, type Visit } from "@/lib/shop-dispatch/model";

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
