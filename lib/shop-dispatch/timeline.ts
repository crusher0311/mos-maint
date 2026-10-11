import { applyCommand, commandSchema, DispatchError, type Board, type Command } from "./model";
import { assertHeldCapacityPreserved, assertLocalPlanAvailable, localParts } from "./schedule-engine";
import { assertDependencyPlans, assertPlanSkills } from "./operations-scheduling";

/** Resolve a wall-clock minute in the shop's timezone, not the browser's.
 * Gaps and repeated DST hours require an explicit time choice, not guessing.
 */
export function timelineInstant(date: string, minute: number, zone: string): string {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight) ||
      new Date(midnight).toISOString().slice(0, 10) !== date ||
      !Number.isInteger(minute) || minute < 0 || minute >= 1440) {
    throw new DispatchError(400, "Choose a valid date and time.");
  }
  const desired = midnight + minute * 60_000;
  const candidates = new Set<number>();
  try {
    // Sample offsets around the requested date, including both sides of a clock
    // transition. Offsets are minute-based, including half/quarter-hour zones.
    for (let hours = -36; hours <= 36; hours += 6) {
      const sample = desired + hours * 3_600_000;
      const p = localParts(sample, zone);
      const offset = Date.parse(`${p.date}T00:00:00Z`) + p.minute * 60_000 - sample;
      const candidate = desired - offset;
      const actual = localParts(candidate, zone);
      if (actual.date === date && actual.minute === minute) candidates.add(candidate);
    }
  } catch {
    throw new DispatchError(400, "Configure a valid shop timezone before scheduling.");
  }
  if (candidates.size !== 1) {
    throw new DispatchError(400, candidates.size
      ? "This local time occurs twice during a clock change. Choose a time outside the repeated hour."
      : "This local time does not exist during a clock change. Choose another time.");
  }
  return new Date([...candidates][0]).toISOString();
}

/** Pure browser preview using the same rules as the authoritative plan write.
 * This never authorizes work, changes book labor, or persists the simulated board.
 */
export function buildTimelinePlan(
  board: Board, jobId: string, technicianId: string, start: string,
  minutes: number, now = Date.now(),
): Extract<Command, {type: "plan"}> {
  if (!board.schedule?.settings?.enabled) {
    throw new DispatchError(409, "Enable scheduling and configure technician shifts first.");
  }
  const job = board.jobs.find(j => j.id === jobId);
  if (!job) throw new DispatchError(404, "This job is no longer on the board. Refresh the schedule.");
  if (job.sourceRemoved) throw new DispatchError(409, "This job was removed upstream. Review it before scheduling.");
  const parsed = commandSchema.safeParse({
    type: "plan", jobId, technicianId, plannedStart: start, estimatedMinutes: minutes,
    prerequisites: [...job.prerequisites], resource: job.resource, authorized: job.authorized,
  });
  if (!parsed.success || parsed.data.type !== "plan") {
    throw new DispatchError(400, "Choose a technician, valid start time and a whole-minute duration from 1 to 1440.");
  }
  const command = parsed.data;
  const preview = applyCommand(board, command, {email: "timeline-preview", manager: true, technicianId: null}, new Date(now).toISOString());
  assertHeldCapacityPreserved(board, preview, now);
  assertPlanSkills(preview, jobId);
  assertLocalPlanAvailable(board, preview, jobId, now);
  assertDependencyPlans(preview, jobId, now);
  return command;
}
