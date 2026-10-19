import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const manifest = () => Object.fromEntries([
  ["shopId", 66], ["expiresAt", Date.now() + 600_000],
  ...["contact", "vehicle", "order", "service", "labor", "inspection", "green", "yellow", "red"]
    .map(k => [k, randomUUID()]),
]);
function rejected(m: object, args = ["--operator-approved"]) {
  const r = spawnSync(process.execPath,
    ["--import", "tsx", "scripts/pilot-car-experts-dvi.ts", ...args], {
      encoding: "utf8", timeout: 15000,
      // No database/provider credentials. External network is denied as well.
      env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME,
        NODE_OPTIONS: "--require ./tests/helpers/deny-network-egress.cjs",
        PROTRACTOR_RELAY_MODE: "relay",
        PROTRACTOR_RELAY_URL: "https://protractor-relay.mos.tools/relay",
        PROTRACTOR_RELAY_HMAC_SECRET: "offline-test-placeholder-not-a-real-secret",
        PILOT_MANIFEST: JSON.stringify(m) },
    });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /"pilotStopped":true/);
  assert.match(r.stderr, /"code":"ERR_ASSERTION"/);
  assert.doesNotMatch(r.stderr, /Missing MongoDB|ENETUNREACH|network egress/i);
}
test("pilot requires explicit operator approval before database access", () => rejected(manifest(), []));
test("pilot rejects another shop before database access", () => rejected({...manifest(), shopId: 1}));
test("pilot rejects expired and overlong permissions", () => {
  rejected({...manifest(), expiresAt: 0});
  rejected({...manifest(), expiresAt: Date.now() + 7_200_000});
});
test("pilot rejects malformed and reused fixture IDs", () => {
  rejected({...manifest(), order: "an-existing-customer-order"});
  const m = manifest();
  rejected({...m, vehicle: m.contact});
});
