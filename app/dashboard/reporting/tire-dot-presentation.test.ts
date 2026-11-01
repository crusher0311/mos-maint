import assert from "node:assert/strict";
import test from "node:test";
import { tirePostedDay, tirePresetRange } from "./tire-dot-presentation";

test("presets use the location day across UTC year/month boundaries", () => {
  const now = new Date("2025-01-01T00:30:00Z");
  assert.deepEqual(tirePresetRange("7", "America/Los_Angeles", now), { start: "2024-12-25", end: "2024-12-31" });
  assert.deepEqual(tirePresetRange("month", "America/Los_Angeles", now), { start: "2024-12-01", end: "2024-12-31" });
  assert.deepEqual(tirePresetRange("30", "Asia/Tokyo", now), { start: "2024-12-03", end: "2025-01-01" });
});

test("presets count calendar days across DST, not 24-hour local intervals", () => {
  assert.deepEqual(tirePresetRange("7", "America/Los_Angeles", new Date("2024-03-11T06:30:00Z")), {
    start: "2024-03-04", end: "2024-03-10",
  });
});

test("presets reject unavailable timezone metadata instead of falling back", () => {
  assert.throws(() => tirePresetRange("7", ""));
  assert.throws(() => tirePresetRange("7", "Invalid/Timezone"));
});

test("posted days use the result's per-location pinned zone", () => {
  const instant = "2025-01-01T00:30:00Z";
  const pinned = { "311": "America/Los_Angeles", "32": "Asia/Tokyo" };
  assert.equal(tirePostedDay(instant, 311, pinned), "2024-12-31");
  assert.equal(tirePostedDay(instant, 32, pinned), "2025-01-01");
});

test("only missing result timezone maps select legacy UTC", () => {
  assert.equal(tirePostedDay("2025-01-01T00:30:00Z", 311), "2025-01-01");
  assert.equal(tirePostedDay("2025-01-01T00:30:00Z", 311, {}), "Timezone unavailable");
  assert.equal(tirePostedDay("2025-01-01T00:30:00Z", 311, { "311": "Invalid/Timezone" }), "Timezone unavailable");
  assert.equal(tirePostedDay("not-a-date", 311, { "311": "UTC" }), "Date unavailable");
  assert.equal(tirePostedDay("", 311), "—");
});
