import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeFakeDb } from "./utils/fake-mongo";
import { __deps } from "../app/api/webhooks/tekmetric/deps";
import { POST } from "../app/api/webhooks/tekmetric/route";

async function main() {
  delete process.env.TEKMETRIC_WEBHOOK_SECRET;
  delete process.env.WEBHOOK_FORWARD_TARGETS;
  const fake = makeFakeDb({
    shops: [{ shopId: 7, tekmetric: { shopId: 100 } }, { shopId: 8, tekmetric: { shopId: 200 } }],
    tekmetric_work_orders: [], tekmetric_webhook_logs: [], dashboard_updates: [],
  });
  const original = { ...__deps };
  const writes: any[] = [];
  __deps.getDb = async () => fake.db as any;
  __deps.defer = () => {}; // Never run live provider enrichment from tests.
  __deps.insertWebhookLog = async () => {};
  __deps.recordDviEvidence = async (...args) => { writes.push(args); };
  try {
    const send = async (event: string, ro: any) => {
      const response = await POST(new NextRequest("http://localhost/api/webhooks/tekmetric", {
        method: "POST", headers: { "x-webhook-forward": "true" },
        body: JSON.stringify({ event, data: ro }),
      }));
      assert.equal(response.status, 200);
    };
    const ro = { id: 123, repairOrderNumber: 10, shopId: 100,
      repairOrderStatus: { name: "In Progress", code: "IN_PROGRESS" } };
    await send("Someone viewed their inspection for Repair Order #10", ro);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], 7);
    assert.equal(writes[0][1], "123");
    assert.equal(writes[0][2].inspectionSharedAt, undefined);
    assert(writes[0][2].inspectionViewReceivedAt);
    await send("Someone viewed their estimate for Repair Order #10", ro);
    await send("Customer viewed VHI", ro);
    await send("CustomerViewedInspection", ro);
    assert.equal(writes.length, 1);
    const shareDate = "2026-10-02T18:00:00.000Z";
    await send("RepairOrder.Updated", { ...ro, inspectionShareDate: shareDate });
    assert.equal(writes.length, 2);
    assert.equal(writes[1][2].inspectionSharedAt, shareDate);
    assert.equal(writes[1][2].inspectionViewReceivedAt, undefined);
    await send("RepairOrder.Updated", { ...ro, estimateShareDate: shareDate, invoiceShareDate: shareDate });
    assert.equal(writes.length, 2);
    await send("Someone viewed their inspection for Repair Order #10", { ...ro, shopId: 200 });
    assert.equal(writes.at(-1)[0], 8);
    await send("Someone viewed their inspection for Repair Order #10", { ...ro, shopId: 999 });
    assert.equal(writes.length, 3, "unmapped shops must not gain another shop's evidence");
    console.log("Tekmetric DVI webhook classification, timestamp and shop-scoping checks passed");
  } finally { Object.assign(__deps, original); }
}
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
