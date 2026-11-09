import assert from "node:assert/strict";
import { fleetHistoryDefaults, fleetHistoryWindow, validateFleetHistoryConfig } from "../lib/integrations/protractor/fleet-history-policy";
import { nextOffHours, resolveHistorySchedule } from "../lib/integrations/protractor/history-schedule";
import { historyWorkerHealth, HISTORY_WORKER_PROTOCOL } from "../lib/integrations/protractor/history-worker-health";

const config = { ...fleetHistoryDefaults(), enabled: true, rolloutShopIds: [635] };
config.week = config.week.map(d => ({ ...d, open: "07:00", close: "18:00" }));
const shop = { shopId: 635, protractor: { locations: [{ TimeZone: "Central Standard Time", Address: { Country: "US" } }] } };
assert.equal(resolveHistorySchedule(config, shop).timezone, "America/Chicago");
assert.equal(resolveHistorySchedule(config, shop).source, "protractor");
assert.equal(resolveHistorySchedule(config, { ...shop, timezone: "America/Denver" }).source, "shop_setting");
assert.equal(resolveHistorySchedule(config, { ...shop, timezone: "bad-zone" }).issue, "invalid_timezone");
assert.equal(resolveHistorySchedule(config, { ...shop, protractor: { locations: [...shop.protractor.locations, ...shop.protractor.locations] } }).issue, "ambiguous_location");
assert.equal(resolveHistorySchedule(config, { ...shop, protractor: { locations: [{ TimeZone: "Central Standard Time", Address: { Country: "MX" } }] } }).issue, "unsupported_provider_timezone");
assert.equal(resolveHistorySchedule(config, { ...shop, protractor: { locations: [{ TimeZone: "America/Chicago" }] } }).timezone, "America/Chicago");
const custom = validateFleetHistoryConfig({ ...config, shopSchedules: [{ shopId: 635, timezone: "America/New_York", week: config.week }] });
assert.equal(resolveHistorySchedule(custom, shop).source, "history_override");
assert.equal(resolveHistorySchedule(custom, { shopId: 636 }).hoursSource, "shared_policy");
assert.throws(() => validateFleetHistoryConfig({ ...custom, shopSchedules: [...custom.shopSchedules!, ...custom.shopSchedules!] }));
assert.throws(() => validateFleetHistoryConfig({ ...custom, shopSchedules: [{ ...custom.shopSchedules![0], week: [] }] }));
assert.throws(() => validateFleetHistoryConfig({ ...custom, shopSchedules: [{ ...custom.shopSchedules![0], timezone: "bad" }] }));
assert.equal(fleetHistoryWindow(config, shop, new Date("2026-11-09T13:00:00Z")).reason, "waiting_off_hours");
assert.equal(fleetHistoryWindow(config, shop, new Date("2026-07-06T12:00:00Z")).reason, "waiting_off_hours");
assert.equal(fleetHistoryWindow(config, shop, new Date("2026-11-09T12:55:00Z")).allowed, false);
assert.equal(fleetHistoryWindow(config, { ...shop, shopId: 636 }).reason, "outside_rollout");
const next = (at: string) => nextOffHours("America/Chicago", config.week, new Date(at), date => fleetHistoryWindow(config, shop, date).allowed);
assert.equal(next("2026-11-09T16:00:00Z"), "2026-11-10T00:00:00.000Z");
assert.equal(next("2026-07-06T16:00:00Z"), "2026-07-06T23:00:00.000Z");
assert.equal(next("2026-11-08T16:00:00Z"), "2026-11-08T16:00:00.000Z");
const night = { ...config, week: config.week.map(d => ({ ...d, closed: false, open: "22:00", close: "06:00" })) };
assert.equal(nextOffHours("America/Chicago", night.week, new Date("2026-11-09T08:00:00Z"),
  at => fleetHistoryWindow(night, shop, at).allowed), "2026-11-09T12:00:00.000Z");
const now = Date.now();
const heartbeat = { protocol: HISTORY_WORKER_PROTOCOL, importsEnabled: true, status: "idle", seenAt: new Date(now), revision: "a".repeat(40) };
assert.equal(historyWorkerHealth({}).status, "not_reported");
assert.equal(historyWorkerHealth({ fleetHistoryWorker: heartbeat }, now).ready, true);
for (const patch of [{ seenAt: new Date(now - 90001) }, { importsEnabled: false }, { protocol: 1 }, { status: "stopped" }, { status: "failed" }])
  assert.equal(historyWorkerHealth({ fleetHistoryWorker: { ...heartbeat, ...patch } }, now).ready, false);
console.log("History admin timezone provenance, per-shop schedules, DST, off-hours and worker health checks passed");
