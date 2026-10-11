import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyBoard, type Board, type Job, type Visit } from "../lib/shop-dispatch/model";
import { shopReadinessSummary } from "../lib/shop-dispatch/readiness-summary";
import { promiseRisk } from "../lib/shop-dispatch/operations";

const now = Date.parse("2026-03-09T14:00:00Z");
function fixture(): Board {
  const board = emptyBoard();
  board.operationsEnabled = true;
  board.technicians = [{ id: "tech", name: "Sam", email: "", active: true }];
  const visit: Visit = { id: "v", ro: "100", vehicle: "Test car", customer: "", arrivalAt: "2026-03-08T23:00:00Z",
    promiseAt: "2026-03-09T14:15:00Z", closed: false, provider: "manual", sourceId: null, sourceStatus: null, sourceFetchedAt: null,
    transport: { customerPlan: "unknown", ride: "none", loaner: "none", loanerId: "", pickupAt: null, notes: "" } };
  const job: Job = { id: "j", visitId: "v", title: "Repair", technicianId: null, plannedStart: null,
    estimatedMinutes: 60, bookMinutes: 60, prerequisites: [], resource: null, status: "idle", activeMs: 0, waitingMs: 0,
    since: null, pauseReason: null, sourceId: null, sourceRemoved: false, authorized: false,
    operations: { reviewedAt: new Date(now).toISOString(), reviewedBy: "Manager", parts: "partial", diagnostics: "ready",
      requiredSkills: ["repair"], blockers: [{ id: "b", reason: "Call supplier", owner: "Alex", resolved: false, openedAt: new Date(now).toISOString(), resolvedAt: null }], checks: [] } };
  board.visits = [visit];
  board.jobs = [job];
  board.schedule = { holds: [], settings: { enabled: true, timeZone: "America/Chicago", weekly: [{ day: 1, start: "08:00", end: "17:00" }],
    technicians: [{ id: "tech", weekly: [{ day: 1, start: "08:00", end: "17:00" }], timeOff: [] }], resources: [], leadMinutes: 0, bufferMinutes: 0 },
    appointments: { startDate: "2026-03-09", endDate: "2026-03-11", fetchedAt: new Date(now).toISOString(), complete: true,
      appointments: [{ id: "a", ro: "200", title: "Today's arrival", start: "2026-03-09T16:00:00Z", end: "2026-03-09T17:00:00Z", technicianSourceIds: [] },
        { id: "b", ro: "201", title: "Tomorrow's arrival", start: "2026-03-10T16:00:00Z", end: "2026-03-10T17:00:00Z", technicianSourceIds: [] }] } };
  return board;
}
const section = (result: ReturnType<typeof shopReadinessSummary>, id: string) => result.sections.find(s => s.id === id)!;
test("morning and end-of-day use shop dates and retain source readiness/risk evidence without writes", () => {
  const board = fixture(), before = structuredClone(board);
  const morning = shopReadinessSummary(board, "morning", now);
  const end = shopReadinessSummary(board, "end-of-day", now);
  assert.equal(morning.today, "2026-03-09");
  assert.equal(end.targetDate, "2026-03-10");
  assert.equal(section(morning, "carryover").items.length, 1);
  assert.equal(section(morning, "arrivals").items[0].id, "a");
  assert.equal(section(end, "arrivals").items[0].id, "b");
  assert.match(section(morning, "blockers").items[0].detail, /Owner: Alex/);
  assert.equal(section(morning, "missing").items.length, 2);
  assert.match(section(morning, "staffing").items[0].detail, /Confirmed skill required/);
  assert.equal(section(morning, "promises").items[0].detail, promiseRisk(board, "v", now).reasons.join("; "));
  assert.deepEqual(board, before);
});
test("unknown timezone, readiness, arrival, shifts and promises are not healthy counts", () => {
  const board = fixture();
  board.schedule = undefined;
  board.jobs[0].operations = undefined;
  board.visits[0].arrivalAt = null;
  board.visits[0].promiseAt = null;
  const result = shopReadinessSummary(board, "morning", now);
  for (const id of ["carryover", "arrivals", "blockers", "missing", "staffing", "promises"])
    assert.ok(section(result, id).unknown.length, id);
  assert.equal(section(result, "promises").items.length, 0);
});
test("stale, incomplete, future-dated and out-of-range calendars never report clear arrivals", () => {
  for (const change of [
    { fetchedAt: "2026-03-08T00:00:00Z" }, { complete: false },
    { fetchedAt: "2026-03-10T00:00:00Z" }, { endDate: "2026-03-09" },
  ]) {
    const board = fixture();
    Object.assign(board.schedule!.appointments!, change);
    const result = shopReadinessSummary(board, "morning", now);
    assert.match(section(result, "arrivals").unknown.join(" "), /coverage.*stale/);
  }
});
test("closed visits and completed approvals are excluded; open final-check blockers remain", () => {
  const board = fixture();
  board.jobs[0].status = "completed";
  let result = shopReadinessSummary(board, "morning", now);
  assert.equal(section(result, "missing").items.length, 0);
  assert.equal(section(result, "blockers").items.length, 1);
  board.visits[0].closed = true;
  result = shopReadinessSummary(board, "morning", now);
  for (const id of ["carryover", "blockers", "missing", "promises"])
    assert.equal(section(result, id).items.length, 0);
});
test("local midnight and DST use calendar dates rather than elapsed 24-hour arrival cutoffs", () => {
  const board = fixture();
  const clock = Date.parse("2026-03-09T04:30:00Z"); // March 8, 23:30 CDT, after DST jump
  board.visits[0].arrivalAt = "2026-03-08T06:30:00Z"; // same local date, before DST jump
  const morning = shopReadinessSummary(board, "morning", clock);
  const end = shopReadinessSummary(board, "end-of-day", clock);
  assert.equal(morning.today, "2026-03-08");
  assert.equal(section(morning, "carryover").items.length, 0);
  assert.equal(section(end, "carryover").items.length, 1);
  assert.equal(end.targetDate, "2026-03-09");
});
test("recorded future visits appear without calendar coverage and matching appointments are deduplicated", () => {
  const board = fixture();
  board.visits[0].arrivalAt = "2026-03-09T16:00:00Z";
  board.schedule!.appointments!.appointments[0].ro = "100";
  let result = shopReadinessSummary(board, "morning", now);
  assert.equal(section(result, "arrivals").items.length, 1);
  assert.equal(section(result, "arrivals").items[0].visitId, "v");
  board.schedule!.appointments = undefined;
  result = shopReadinessSummary(board, "morning", now);
  assert.equal(section(result, "arrivals").items.length, 1);
  assert.ok(section(result, "arrivals").unknown.length);
});
