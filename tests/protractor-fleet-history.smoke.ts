import assert from "node:assert/strict";
import { fleetHistoryDefaults, fleetHistoryWindow, validateFleetHistoryConfig, fleetHistoryEndpointAllowed, fleetHistoryAdmission } from "../lib/integrations/protractor/fleet-history-policy";
const c = fleetHistoryDefaults();
assert.equal(c.enabled, false);
assert.equal(fleetHistoryWindow(c, { shopId: 1 }).reason, "disabled");
c.enabled = true;
assert.equal(fleetHistoryWindow(c, { shopId: 1 }).reason, "missing_timezone");
c.defaultTimezone = "America/Chicago";
const shop = { shopId: 1 };
assert.equal(fleetHistoryWindow(c, shop, new Date("2026-10-30T19:00:00Z")).allowed, false);
assert.equal(fleetHistoryWindow(c, shop, new Date("2026-10-31T00:00:00Z")).allowed, true);
assert.equal(fleetHistoryWindow(c, shop, new Date("2026-10-30T12:56:00Z")).allowed, false);
assert.equal(fleetHistoryWindow(c, { ...shop, timezone: "invalid" }).reason, "missing_timezone");
assert.equal(fleetHistoryWindow(c, { ...shop, status: "cancelled" }).reason, "cancelled");
assert.equal(fleetHistoryWindow(c, { ...shop, protractor: { historyControl: { paused: true } } }).reason, "paused");
c.rolloutShopIds = [2];
assert.equal(fleetHistoryWindow(c, shop).reason, "outside_rollout");
c.rolloutShopIds = [];
const overnight = structuredClone(c);
overnight.week = overnight.week.map(d => ({ ...d, closed: false, open: "22:00", close: "06:00" }));
assert.equal(fleetHistoryWindow(overnight, shop, new Date("2026-10-31T08:00:00Z")).allowed, false);
assert.equal(fleetHistoryWindow(overnight, shop, new Date("2026-10-31T17:00:00Z")).allowed, true);
assert.equal(fleetHistoryWindow(overnight, shop, new Date("2026-11-01T07:30:00Z")).allowed, false); // fall-back hour
assert.throws(() => validateFleetHistoryConfig({ ...c, week: [] }));
assert.throws(() => validateFleetHistoryConfig({ ...c, maxShopsPerTick: 100 }));
assert.throws(() => validateFleetHistoryConfig({ ...c, defaultTimezone: "guess" }));
assert.deepEqual(validateFleetHistoryConfig(c), c);
assert.equal(fleetHistoryEndpointAllowed("/Invoice/?startDate=2026-01-01&endDate=2026-01-02&take=100&skip=0", "GET", undefined), true);
for (const [path, method, body] of [
  ["/Invoice/", "POST", "{}"], ["/Contact/123", "GET", undefined],
  ["https://bad/Invoice/?startDate=2026-01-01&endDate=2026-01-02&take=100&skip=0", "GET", undefined],
  ["/Invoice/?startDate=2026-01-01&endDate=2026-01-02&take=100&skip=0&extra=yes", "GET", undefined],
] as const) assert.equal(fleetHistoryEndpointAllowed(path, method, body), false);
assert.deepEqual(fleetHistoryAdmission({} as any), { $literal: false });
console.log("Fleet history scheduling, timezone, DST, opening margin, rollout, cancellation and read-scope checks passed");
