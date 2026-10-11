import type { Board } from "./model";
import { promiseRisk, readinessReasons } from "./operations";
import { availability, localParts } from "./schedule-engine";

export type SummaryMode = "morning" | "end-of-day";
export interface SummaryItem { id: string; label: string; detail: string; visitId?: string; jobId?: string }
export interface SummarySection { id: string; title: string; items: SummaryItem[]; unknown: string[] }

/** A read-only projection of the current shop board, never a booking or forecast. */
export function shopReadinessSummary(board: Board, mode: SummaryMode, now: number) {
  const timeZone = board.schedule?.settings?.timeZone;
  const today = timeZone ? localParts(now, timeZone).date : null;
  const targetDate = today && mode === "end-of-day"
    ? new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : today;
  const section = (id: string, title: string): SummarySection => ({ id, title, items: [], unknown: [] });
  const carryover = section("carryover", mode === "morning" ? "Carryover vehicles" : "Potential overnight carryover");
  const arrivals = section("arrivals", mode === "morning" ? "Today's upcoming arrivals" : "Tomorrow's arrivals");
  const blockers = section("blockers", "Owned blockers");
  const missing = section("missing", "Missing approvals / parts");
  const staffing = section("staffing", "Staffing bottlenecks");
  const promises = section("promises", "Promises at risk");
  const open = board.visits.filter(v => !v.closed);
  const jobs = board.jobs.filter(j => open.some(v => v.id === j.visitId) && j.status !== "completed");
  for (const tech of board.technicians.filter(t => t.active)) {
    if (!board.schedule?.settings?.technicians.some(lane => lane.id === tech.id && lane.weekly.length))
      staffing.unknown.push(`${tech.name}: shifts not configured`);
  }
  const jobItem = (job: typeof jobs[number], detail: string): SummaryItem => ({
    id: job.id, label: `RO ${open.find(v => v.id === job.visitId)!.ro} · ${job.title}`, detail,
    visitId: job.visitId, jobId: job.id,
  });
  for (const visit of open) {
    const item = { id: visit.id, label: `RO ${visit.ro} · ${visit.vehicle}`, visitId: visit.id };
    const arrival = visit.arrivalAt ? Date.parse(visit.arrivalAt) : NaN;
    if (!today || !timeZone || !Number.isFinite(arrival)) carryover.unknown.push(`RO ${visit.ro}: arrival date or shop timezone unknown`);
    else {
      const date = localParts(arrival, timeZone).date;
      if (arrival <= now && (mode === "morning" ? date < today : date <= today))
        carryover.items.push({ ...item, detail: "Open visit by recorded arrival time; physical presence is not verified." });
      if (date === targetDate && arrival >= now)
        arrivals.items.push({ ...item, id: `visit:${visit.id}`, detail: `${visit.arrivalAt} · recorded visit arrival, not a confirmed check-in` });
    }
    const risk = promiseRisk(board, visit.id, now);
    if (risk.level === "at-risk") promises.items.push({ ...item, detail: risk.reasons.join("; ") });
    else if (risk.level === "unknown") promises.unknown.push(`${item.label}: ${risk.reasons.join("; ")}`);
  }
  // Include final-check blockers even on completed jobs in still-open visits.
  for (const job of board.jobs.filter(j => open.some(v => v.id === j.visitId))) {
    for (const b of job.operations?.blockers.filter(b => !b.resolved) ?? [])
      blockers.items.push({ ...jobItem(job, `${b.reason} — Owner: ${b.owner} · Opened ${b.openedAt}`), id: `${job.id}:${b.id}` });
    if (!job.operations) blockers.unknown.push(`${jobItem(job, "").label}: readiness not reviewed`);
  }
  for (const job of jobs) {
    const reasons = readinessReasons(board, job);
    if (!job.authorized || job.sourceRemoved)
      missing.items.push(jobItem(job, "Authorization / source review needed"));
    if (!job.operations || job.operations.parts === "unknown")
      missing.unknown.push(`${jobItem(job, "").label}: parts readiness unknown`);
    else if (reasons.some(r => r.startsWith("Parts:")))
      missing.items.push({ ...jobItem(job, `Parts: ${job.operations.parts}`), id: `${job.id}:parts` });
    const tech = board.technicians.find(t => t.id === job.technicianId && t.active);
    const skills = reasons.filter(r => r.startsWith("Confirmed skill required:"));
    if (!tech || skills.length) staffing.items.push(jobItem(job, [!tech ? "No active assigned technician" : "", ...skills].filter(Boolean).join("; ")));
    if (!job.operations) staffing.unknown.push(`${jobItem(job, "").label}: required skills not reviewed`);
  }
  if (!targetDate || !timeZone) {
    arrivals.unknown.push("Shop timezone is not configured.");
    staffing.unknown.push("Configure shop timezone and shifts to assess capacity.");
  } else {
    const endDate = new Date(Date.parse(`${targetDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const coverage = availability(board, { startDate: targetDate, endDate, durationMinutes: 15 }, now);
    staffing.unknown.push(...coverage.reasons, ...coverage.warnings);
    // Reuse the scheduler's freshness/completeness gate; never report an empty stale calendar as clear.
    arrivals.unknown.push(...coverage.reasons.filter(r => r.startsWith("Appointment coverage")));
    for (const appointment of board.schedule?.appointments?.appointments ?? []) {
      const start = appointment.start ? Date.parse(appointment.start) : NaN;
      if (!Number.isFinite(start)) { arrivals.unknown.push(`${appointment.title}: arrival time unknown`); continue; }
      // A matching RO already represented by its local arrival is one vehicle, not two.
      const local = open.find(v => v.ro === appointment.ro && arrivals.items.some(i => i.visitId === v.id));
      if (local) {
        if (Date.parse(local.arrivalAt!) !== start)
          arrivals.unknown.push(`RO ${local.ro}: recorded visit and cached appointment arrival times differ`);
        continue;
      }
      if (localParts(start, timeZone).date === targetDate && (mode === "end-of-day" || start >= now))
        arrivals.items.push({ id: appointment.id, label: `${appointment.ro ? `RO ${appointment.ro} · ` : ""}${appointment.title}`, detail: `${appointment.start} · cached appointment, not a verified work plan` });
    }
    if (!coverage.reasons.length && !coverage.slots.length)
      staffing.items.push({ id: "capacity", label: "No bookable 15-minute capacity in this date window", detail: "Conservative scheduling check includes lead time and reservations; not proof of technician overload." });
  }
  return { mode, today, targetDate, timeZone: timeZone ?? null, generatedAt: new Date(now).toISOString(),
    updatedAt: board.updatedAt, appointmentFetchedAt: board.schedule?.appointments?.fetchedAt ?? null,
    sections: [carryover, arrivals, blockers, missing, staffing, promises] };
}
