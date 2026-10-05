import assert from "node:assert/strict";
import {
  auditReceiptPrimaryId,
  auditReceiptSourceForIngestion,
  auditReceiptUpstreamUpdatedAt,
  hasCompleteAuditTicket,
  mapTekmetricAuditReceiptLineItems,
} from "../lib/integrations/core/normalized-ingestion";
import { mayScheduleVerifiedWebhookAudit } from "../lib/integrations/core/webhook-audit-admission";
import { buildShopwareAuditReceipt } from "../lib/data/repositories/estimate-audit-receipts";
import { fingerprintAuditInput } from "../lib/estimate-assist/audit-automation";

// Admission is intentionally conservative: an unattributed legacy ingestion
// must never be treated as live when automation is enabled later.
assert.equal(auditReceiptSourceForIngestion(), null);
assert.equal(auditReceiptSourceForIngestion(undefined, "tekmetric-fullpage-42"), null);
assert.equal(auditReceiptSourceForIngestion("backfill"), null);
assert.equal(auditReceiptSourceForIngestion("webhook"), "webhook");
assert.equal(auditReceiptSourceForIngestion("incremental_sync"), "poll");
assert.equal(auditReceiptSourceForIngestion("create-work-order"), "live");
assert.equal(auditReceiptSourceForIngestion("webhook-queue-replay"), "webhook");
assert.equal(auditReceiptSourceForIngestion("webhook-queue-replay", "historical-replay"), null);
assert.equal(auditReceiptSourceForIngestion("webhook-replay"), null);

// Stable provider primary keys are required; numbers and normalized IDs never
// become audit state identity fallbacks.
assert.equal(auditReceiptPrimaryId("tekmetric", { id: 77, repairOrderNumber: "RO-7" }), "77");
assert.equal(auditReceiptPrimaryId("protractor", { ID: "guid-7", WorkOrderNumber: "RO-7" }), "guid-7");
assert.equal(auditReceiptPrimaryId("shopmonkey", { number: "RO-7" }), null);

// Empty collections are a valid complete ticket (so resolved warnings clear);
// missing collections are sparse/partial provider projections.
assert.equal(hasCompleteAuditTicket("tekmetric", { id: 1, jobs: [] }), true);
assert.equal(hasCompleteAuditTicket("tekmetric", { id: 1 }), false);
assert.equal(hasCompleteAuditTicket("protractor", { ID: "a", ServicePackages: { ItemCollection: [] } }), true);
assert.equal(hasCompleteAuditTicket("protractor", { ID: "a", ServicePackages: null }), false);
assert.equal(hasCompleteAuditTicket("shopmonkey", { id: "a", serviceItems: [] }), true);
assert.equal(hasCompleteAuditTicket("shopmonkey", { id: "a" }), false);

assert.equal(
  auditReceiptUpstreamUpdatedAt("tekmetric", { updatedDate: "2026-07-01T12:00:00.000Z" }),
  "2026-07-01T12:00:00.000Z",
);
assert.equal(
  auditReceiptUpstreamUpdatedAt("protractor", { Header: { LastModifiedTime: "2026-07-01T12:00:00.000Z" } }),
  "2026-07-01T12:00:00.000Z",
);
assert.equal(
  auditReceiptUpstreamUpdatedAt("tekmetric", { updatedAt: "2026-07-01T12:00:00.000Z" }),
  null,
  "local ingestion/cache timestamps must not reorder provider receipts",
);
assert.equal(auditReceiptUpstreamUpdatedAt("shopmonkey", { updatedDate: "not-a-date" }), null);

const [tekmetricLine] = mapTekmetricAuditReceiptLineItems({
  jobs: [{
    id: 10,
    name: "Brake service",
    laborAmount: 12550,
    partsPrice: 8049,
    totalAmount: 23149,
    labor: [{ hours: 1.5, rate: 8366 }],
    parts: [{ name: "Brake pads", quantity: 2, retail: 4024 }],
  }],
});
assert.deepEqual(tekmetricLine, {
  title: "Brake service",
  description: undefined,
  type: "custom",
  laborHours: 1.5,
  laborTotal: 125.5,
  partsTotal: 80.49,
  parts: [{ description: "Brake pads", quantity: 2, unitPrice: 40.24 }],
  total: 231.49,
});
const [tekmetricAliasLine] = mapTekmetricAuditReceiptLineItems({
  jobs: [{
    id: 11,
    name: "Alignment",
    laborPrice: 9900,
    partsAmount: 1550,
    subtotal: 11450,
    laborHours: 1.25,
  }],
});
assert.deepEqual(tekmetricAliasLine, {
  title: "Alignment",
  description: undefined,
  type: "custom",
  laborHours: 1.25,
  laborTotal: 99,
  partsTotal: 15.5,
  parts: undefined,
  total: 114.5,
});

// Existing permissive webhook delivery behavior may remain during signature
// rollout, but it must not admit automatic audit work without verification.
assert.equal(mayScheduleVerifiedWebhookAudit(undefined, null), false);
assert.equal(mayScheduleVerifiedWebhookAudit("secret", "signature mismatch"), false);
assert.equal(mayScheduleVerifiedWebhookAudit("secret", null), true);

// Shop-Ware webhook, poll, and live reads share the one mapper, so the same
// complete provider ticket always produces the same audit fingerprint.
const shopwareTicket: any = {
  id: 99,
  number: 1001,
  updated_at: "2026-07-01T12:00:00.000Z",
  odometer: 71000,
  vehicle: { vin: "1HGCM82633A004352", year: "2022", make: "Honda", model: "Civic" },
  services: [{
    id: 4,
    title: "Front brake service",
    comment: "Pads and rotors",
    category_id: 7,
    completed: false,
    is_fixed_price_service: false,
    labor_rate_cents: 15000,
    labors: [{ hours: 2 }],
    parts: [{ description: "Brake pad set", quantity: 1, sell_price_cents: 12999 }],
    sublets: [{ price_cents: 2500 }],
    hazmats: [{ fee_cents: 500, quantity: 1 }],
  }],
};
const shopwareWebhookReceipt = buildShopwareAuditReceipt(123, shopwareTicket, "webhook");
const shopwarePollReceipt = buildShopwareAuditReceipt(123, shopwareTicket, "poll");
const shopwareLiveReceipt = buildShopwareAuditReceipt(123, shopwareTicket, "live");
assert.ok(shopwareWebhookReceipt && shopwarePollReceipt && shopwareLiveReceipt);
assert.equal(
  fingerprintAuditInput(shopwareWebhookReceipt),
  fingerprintAuditInput(shopwarePollReceipt),
);
assert.equal(
  fingerprintAuditInput(shopwareWebhookReceipt),
  fingerprintAuditInput(shopwareLiveReceipt),
);
assert.equal(
  buildShopwareAuditReceipt(123, {
    ...shopwareTicket,
    services: [{ ...shopwareTicket.services[0], labors: undefined }],
  }, "poll"),
  null,
  "a non-empty Shop-Ware service list without requested labor associations is partial",
);

console.log("estimate-audit receipt smoke tests passed");