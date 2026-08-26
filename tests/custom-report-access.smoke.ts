import assert from "node:assert/strict";
import {
  canReadCustomReport,
  canWriteCustomReport,
  isCustomReportOwner,
} from "../lib/custom-report-access";
import { currentCustomReportDefinition } from "../lib/data/repositories/custom-reports";

const owner = { email: "Owner@Example.com" };
const other = { email: "other@example.com" };
const privateReport = { ownerEmail: "owner@example.com", sharing: { visibility: "private" as const } };

assert.equal(isCustomReportOwner(owner, privateReport), true, "owner email comparison is canonical");
assert.equal(canReadCustomReport(other, privateReport, { shopIds: [10] }), false, "private reports stay private");
assert.equal(canWriteCustomReport(other, privateReport), false, "shared readers cannot mutate reports");
assert.equal(canWriteCustomReport({ ...other, isPlatformAdmin: true }, privateReport), true, "platform admins can administer reports");

const shopReport = {
  ownerEmail: "owner@example.com",
  sharing: { visibility: "shop" as const, shopIds: [10, 11] },
};
assert.equal(canReadCustomReport(other, shopReport, { shopIds: [10] }), true, "shop member can read");
assert.equal(canReadCustomReport(other, shopReport, { shopIds: [12] }), false, "unrelated shop cannot read");

const enterpriseReport = {
  ownerEmail: "owner@example.com",
  sharing: { visibility: "enterprise" as const, enterpriseId: "ent-1" },
};
assert.equal(canReadCustomReport(other, enterpriseReport, { shopIds: [10], enterpriseId: "ent-1" }), true);
assert.equal(canReadCustomReport(other, enterpriseReport, { shopIds: [10], enterpriseId: "ent-2" }), false);

const versions = [
  { version: 1, definition: { metrics: ["old"] }, createdAt: new Date(0), createdBy: "a" },
  { version: 2, definition: { metrics: ["new"] }, createdAt: new Date(1), createdBy: "a" },
];
assert.deepEqual(
  currentCustomReportDefinition({ currentVersion: 2, versions })?.definition,
  { metrics: ["new"] },
  "execution selects the immutable current version",
);

console.log("custom report access smoke: ok");