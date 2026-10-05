import assert from "node:assert/strict";
import {
  engagementFromTekmetric, normalizeDviEngagement, tekmetricInspectionViewRo,
  tekmetricRoId, unknownDviEngagement, evidenceTimestamp,
} from "../lib/dvi-engagement";
import { loadReportDviEngagement } from "../lib/missed-opportunities-dvi";
import {
  normalizeMissedOpportunityReportCache, MISSED_OPPORTUNITY_REPORT_VERSION,
} from "../lib/missed-opportunities";

const sentAt = "2026-10-02T18:00:00.000Z";
const viewedAt = "2026-10-02T18:26:30.045Z";
const provenance = (id: string) => ({ sourceIds: [
  { system: "tekmetric", idType: "repair_order_id", idValue: id },
] });

async function main() {
  const sent = engagementFromTekmetric({ workOrderId: "1", inspectionShareDate: sentAt });
  assert.equal(sent.sent.status, "positive");
  assert.equal(sent.sent.timestampKind, "event");
  assert.equal(sent.viewed.status, "unknown");
  const viewed = engagementFromTekmetric({ workOrderId: "1", dviInspectionViewReceivedAt: viewedAt });
  assert.equal(viewed.viewed.status, "positive");
  assert.equal(viewed.viewed.timestampKind, "received");
  assert.equal(viewed.sent.status, "unknown");
  assert.equal(viewed.sent.timestamp, undefined);
  assert.deepEqual(engagementFromTekmetric(), unknownDviEngagement());
  assert.deepEqual(engagementFromTekmetric({
    workOrderId: "1", customerViewedDvi: true, customerViewedDviAt: viewedAt,
    estimateShareDate: sentAt, invoiceShareDate: sentAt, inspectionCompleted: true,
    shareLink: "https://example.com/dvi",
  } as any), unknownDviEngagement());
  assert.equal(evidenceTimestamp("2026-10-02"), undefined);
  assert.equal(evidenceTimestamp("2026-10-02T18:00:00"), undefined);
  assert.equal(evidenceTimestamp("garbage"), undefined);

  const ro = { id: 123, shopId: 5, repairOrderNumber: 10 };
  assert.equal(tekmetricInspectionViewRo("Someone viewed their inspection for Repair Order #10", ro), "123");
  for (const event of [
    "Customer viewed estimate", "Someone viewed their estimate for Repair Order #10",
    "CustomerViewedInspection", "Inspection marked complete", "Customer viewed VHI",
    "Someone viewed their inspection for Repair Order #11",
  ]) assert.equal(tekmetricInspectionViewRo(event, ro), undefined);
  assert.equal(tekmetricInspectionViewRo("Someone viewed their inspection for Repair Order #10", { ...ro, shopId: null }), undefined);
  assert.equal(tekmetricRoId(provenance("123")), "123");
  assert.equal(tekmetricRoId({ sourceIds: [{ system: "tekmetric", idType: "repair_order_number", idValue: "10" }] }), undefined);
  assert.equal(tekmetricRoId({ sourceIds: [...provenance("1").sourceIds, ...provenance("2").sourceIds] }), undefined);

  const explicit = normalizeDviEngagement({
    sent: { status: "negative", source: "Verified source", context: "Explicitly not sent" },
    viewed: { status: "unsupported", source: "Verified contract", context: "Views are not tracked" },
  });
  assert.equal(explicit.sent.status, "negative");
  assert.equal(explicit.viewed.status, "unsupported");
  assert.deepEqual(normalizeDviEngagement({ sent: { status: "negative" }, viewed: { status: "unsupported" } }), unknownDviEngagement());

  let calls = 0;
  const rows = [
    { id: "visit1", provenance: provenance("1"), vin: "SAMEVIN" },
    { id: "visit2", provenance: provenance("2"), vin: "SAMEVIN" },
    { id: "otherProvider", provenance: { sourceIds: [{ system: "protractor", idType: "work_order_id", idValue: "1" }] } },
  ];
  const result = await loadReportDviEngagement(7, rows, async (shop, ids, budget) => {
    calls++;
    assert.equal(shop, 7);
    assert.deepEqual(ids, ["1", "2"]);
    assert.equal(budget, 1000);
    return [
      { workOrderId: "1", dviInspectionSharedAt: sentAt },
      { workOrderId: "1", dviInspectionSharedAt: viewedAt, dviInspectionViewReceivedAt: viewedAt },
      { workOrderId: "unselected", dviInspectionSharedAt: sentAt },
    ];
  });
  assert.equal(calls, 1);
  assert.equal(result.get("visit1")?.sent.timestamp, sentAt);
  assert.equal(result.get("visit1")?.viewed.status, "positive");
  assert.deepEqual(result.get("visit2"), unknownDviEngagement());
  assert.deepEqual(result.get("otherProvider"), unknownDviEngagement());
  await loadReportDviEngagement(8, rows, async shop => {
    assert.equal(shop, 8);
    return [];
  });
  const failure = await loadReportDviEngagement(7, rows, async () => { throw new Error("offline"); });
  assert.deepEqual(failure.get("visit1"), unknownDviEngagement());
  const start = Date.now();
  const timeout = await loadReportDviEngagement(7, rows, () => new Promise(() => {}), 10);
  assert(Date.now() - start < 500);
  assert.deepEqual(timeout.get("visit1"), unknownDviEngagement());
  await loadReportDviEngagement(7, rows, async () => { throw new Error("must not run"); }, 0);
  await loadReportDviEngagement(7,
    Array.from({ length: 400 }, (_, i) => ({ id: String(i), provenance: provenance(String(i + 1)) })),
    async (_shop, ids) => { assert.equal(ids.length, 300); return []; });

  const old = normalizeMissedOpportunityReportCache({ rows: [{ workOrderId: "1" }], notEvaluated: [{ workOrderId: "2" }] });
  assert.deepEqual(old.rows[0].dviEngagement, unknownDviEngagement());
  assert.deepEqual(old.notEvaluated[0].dviEngagement, unknownDviEngagement());
  const current = { reportVersion: MISSED_OPPORTUNITY_REPORT_VERSION,
    rows: [{ dviEngagement: result.get("visit1"), recommendations: [], ticketJobs: [] }], notEvaluated: [] };
  const roundtrip = normalizeMissedOpportunityReportCache(JSON.parse(JSON.stringify(current)));
  assert.deepEqual(roundtrip.rows[0].dviEngagement, result.get("visit1"));
  console.log("DVI evidence, classification, isolation, partial tracking, legacy/cache and bounded enrichment checks passed");
}
main().catch(err => { console.error(err); process.exit(1); });
