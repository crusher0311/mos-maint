import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dashboardAuditContext,
  dashboardAuditStatusKey,
  dashboardAuditStatusVisual,
  dashboardAuditWorkOrderIdFromProvenance,
} from "../lib/dashboard-audit-status";

// These are the actual public row shapes emitted by the four primary
// aggregation paths in /api/dashboard/data. Each has a human display number
// that intentionally differs from the provider id used by audit state.
const rowsFromDashboardAggregations = [
  {
    source: "protractor",
    displayRo: 1001,
    workOrderGuid: "protractor-invoice-guid",
    auditWorkOrderId: "protractor-invoice-guid",
  },
  {
    source: "tekmetric",
    displayRo: 2002,
    workOrderId: 881122,
    auditWorkOrderId: 881122,
  },
  {
    source: "shopware",
    displayRo: "SW-3003",
    roId: 771133,
    auditWorkOrderId: 771133,
  },
  {
    source: "shopmonkey",
    displayRo: "SM-4004",
    auditWorkOrderId: "shopmonkey-order-id",
  },
];

const expectedAuditContexts = [
  { provider: "protractor", workOrderId: "protractor-invoice-guid" },
  { provider: "tekmetric", workOrderId: "881122" },
  { provider: "shopware", workOrderId: "771133" },
  { provider: "shopmonkey", workOrderId: "shopmonkey-order-id" },
];
for (let index = 0; index < rowsFromDashboardAggregations.length; index += 1) {
  const context = dashboardAuditContext(rowsFromDashboardAggregations[index]);
  assert.deepEqual(
    context,
    expectedAuditContexts[index],
    `${expectedAuditContexts[index].provider} aggregation routes status to its stable provider id`,
  );
  assert.equal(
    dashboardAuditStatusKey(context!),
    `${expectedAuditContexts[index].provider}|${expectedAuditContexts[index].workOrderId}`,
  );
}

// Shopmonkey is normalized rather than cached. Its dashboard mapper must read
// order.id from the canonical provenance source-id shape emitted by the
// Shopmonkey adapter, not workOrderNumber.
const shopmonkeyProvenance = {
  sourceSystem: "shopmonkey",
  sourceIds: [
    { system: "shopmonkey", idType: "repair_order_number", idValue: "SM-4004", isPrimary: false },
    { system: "shopmonkey", idType: "repair_order_id", idValue: "shopmonkey-order-id", isPrimary: true },
  ],
};
assert.equal(
  dashboardAuditWorkOrderIdFromProvenance(shopmonkeyProvenance, "shopmonkey"),
  "shopmonkey-order-id",
  "Shopmonkey dashboard mapping projects the primary order.id from provenance",
);

for (const provider of ["tekmetric", "protractor", "shopware"]) {
  const providerProvenance = {
    sourceIds: [
      { system: provider, idType: "repair_order_number", idValue: "display-only", isPrimary: false },
      { system: provider, idType: "repair_order_id", idValue: `${provider}-primary-id`, isPrimary: true },
    ],
  };
  assert.equal(
    dashboardAuditWorkOrderIdFromProvenance(providerProvenance, provider),
    `${provider}-primary-id`,
    `${provider} normalized dashboard mapping keeps its primary provider identity`,
  );
}

assert.equal(
  dashboardAuditContext({ source: "shopmonkey", displayRo: "SM-4004" }),
  null,
  "status reads never fall back to a display RO number",
);
assert.equal(
  dashboardAuditWorkOrderIdFromProvenance({
    sourceIds: [{ system: "shopmonkey", idType: "repair_order_number", idValue: "SM-4004", isPrimary: false }],
  }, "shopmonkey"),
  undefined,
  "a provenance display-number entry cannot be mistaken for a state key",
);

const warning = dashboardAuditStatusVisual({
  status: "complete",
  report: { summary: { warnings: 1, critical: 0 } },
});
assert.deepEqual(
  warning && { symbol: warning.symbol, label: warning.label },
  { symbol: "⚠", label: "1 warning needs review" },
  "a warning is visibly represented before the row entry is opened",
);

const critical = dashboardAuditStatusVisual({
  status: "complete",
  report: { summary: { warnings: 0, critical: 2 } },
});
assert.deepEqual(
  critical && { symbol: critical.symbol, label: critical.label },
  { symbol: "⛔", label: "2 critical findings need review" },
  "critical state has a distinct visible indicator before the row entry is opened",
);

assert.equal(dashboardAuditStatusVisual({ status: "pending" })?.symbol, "…");
assert.equal(dashboardAuditStatusVisual({ status: "stale" })?.symbol, "↻");
assert.equal(dashboardAuditStatusVisual({ status: "partial" })?.symbol, "◐");
assert.equal(dashboardAuditStatusVisual({ status: "unavailable" })?.symbol, "?");
assert.equal(
  dashboardAuditContext({ source: "autoflow", auditWorkOrderId: "unsafe-to-guess" }),
  null,
  "unsupported providers are never queried by dashboard status reads",
);

const dashboardSource = readFileSync("app/dashboard/DashboardClient.tsx", "utf8");
const dashboardDataSource = readFileSync("app/api/dashboard/data/route.ts", "utf8");
const dashboardDataV2Source = readFileSync("app/api/dashboard/data-v2/route.ts", "utf8");
const panelSource = readFileSync("components/EstimateAssistPanel.tsx", "utf8");
assert.match(
  dashboardSource,
  /VISIBLE_AUDIT_STATUS_LIMIT = 12[\s\S]*setInterval\(refresh, 30000\)/,
  "dashboard status reads stay bounded to a low visible-row limit and refresh interval",
);
assert.ok(
  dashboardSource.includes("auditStatusVisual.symbol") && dashboardSource.includes("rowAuditStatuses[dashboardAuditStatusKey(auditContext)]"),
  "the real FileSearch row-entry button renders the resolved status badge before opening its modal",
);
assert.match(
  dashboardDataSource,
  /workOrderGuid: "\$workOrderGuid",\s*\/\/ Stable Protractor GUID[\s\S]*?auditWorkOrderId: "\$workOrderGuid"/,
  "Protractor aggregation projects its GUID as the audit state id",
);
assert.match(
  dashboardDataSource,
  /workOrderId: "\$workOrderId",\s*\/\/ Stable Tekmetric order id[\s\S]*?auditWorkOrderId: "\$workOrderId"/,
  "Tekmetric aggregation projects its order id as the audit state id",
);
assert.match(
  dashboardDataSource,
  /roId: "\$roId",\s*\/\/ Stable Shop-Ware repair-order id[\s\S]*?auditWorkOrderId: "\$roId"/,
  "Shop-Ware aggregation projects its repair-order id as the audit state id",
);
assert.match(
  dashboardDataSource,
  /provenance: 1,[\s\S]*?dashboardAuditWorkOrderIdFromProvenance\(provenance, "shopmonkey"\)/,
  "Shopmonkey aggregation maps the normalized primary provenance id into its row",
);
assert.match(
  dashboardDataV2Source,
  /dashboardAuditWorkOrderIdFromProvenance\(wo\.provenance, source\)/,
  "the normalized dashboard path uses the same provenance-backed audit identity",
);
assert.match(
  dashboardSource,
  /statusWorkOrderId: auditContext\?\.workOrderId/,
  "the row-entry modal receives the same audited provider id as its status badge",
);
assert.doesNotMatch(
  dashboardSource,
  /statusWorkOrderId: String\(r\.workOrderGuid \|\| r\.workOrderId \|\| r\.roId \|\| r\.displayRo/,
  "the row-entry modal no longer guesses status identity from its display RO",
);
assert.doesNotMatch(
  panelSource,
  /initialStatusWorkOrderId \|\| auditId/,
  "the panel never substitutes its manual audit id for a missing status id",
);
assert.doesNotMatch(
  panelSource,
  /smsWorkOrderId \|\| data\.report\?\.workOrderId \|\| auditId/,
  "a live audit result never turns a normalized/manual id into a status key",
);

console.log("dashboard estimate audit row-status smoke: all assertions passed");