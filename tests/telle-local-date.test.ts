import test from "node:test";
import assert from "node:assert/strict";
import {localDate} from "../scripts/lib/telle-local-date";
test("Telle comparison uses Chicago calendar dates across DST and midnight", () => {
  for (const [value, expected] of [
    ["2026-01-01T05:59:59Z", "2025-12-31"],
    ["2026-01-01T06:00:00Z", "2026-01-01"],
    ["2026-03-08T07:59:59Z", "2026-03-08"],
    ["2026-03-08T08:00:00Z", "2026-03-08"],
    ["2026-07-01T04:59:59Z", "2026-06-30"],
    ["2026-07-01T05:00:00Z", "2026-07-01"],
    ["2026-11-01T07:00:00Z", "2026-11-01"],
    ["2026-11-09T05:59:59Z", "2026-11-08"],
    ["2026-11-09T06:00:00Z", "2026-11-09"],
  ]) assert.equal(localDate(value, "America/Chicago"), expected);
  for (const invalid of [undefined, null, "", "invalid", 123]) {
    assert.equal(localDate(invalid, "America/Chicago"), "");
  }
});
