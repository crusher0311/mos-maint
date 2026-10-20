import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmedRO, photoAllowed, safeLocalHref, submitFrozenRO, readROSession, saveROSession, removeROSession, DRAFT_RETENTION_MS, type ROSession, type JsonPost } from "./ro-session-store";
import { offlineRODatabase } from "./ro-recovery.offline-fixture";

const requestId = "f037c214-b117-446e-87b4-d361893cf458";
const workOrderId = "1809c214-b117-446e-87b4-d361893cf458";
const payload = JSON.stringify({ clientRequestId: requestId, contactId: "contact-retained", vehicleId: "vehicle-retained",
  concerns: ["Rattle over bumps", "Brake pedal vibration"], note: "Customer waiting", mileage: 84217,
  servicePackages: [{ source: "canned", title: "Brake diagnosis", lines: [{ quantity: 1, unitPrice: 137.5 }] }] });
const session = (): ROSession => ({ shopId: 66, actorKey: "offline-advisor", payload, photos: [], handoffRequestId: requestId });
const success = { ok: true, workOrderId, workOrderNumber: 18427 };

test("unsent drafts expire across scopes; legacy photos and unresolved provider receipts survive", async () => {
  const fixture = offlineRODatabase();
  Object.assign(globalThis, { indexedDB: fixture.indexedDB });
  const old = Date.now() - DRAFT_RETENTION_MS - 1000;
  const unsent = { ...session(), payload: undefined, updatedAt: old, draft: { version: 1 as const, fields: "{}" } };
  fixture.records.set(JSON.stringify([66, "offline-advisor"]), unsent);
  fixture.records.set(JSON.stringify([67, "offline-advisor"]), { ...unsent, shopId: 67 });
  fixture.records.set(JSON.stringify([68, "offline-advisor"]), { ...session(), shopId: 68, updatedAt: old });
  fixture.records.set(JSON.stringify([69, "offline-advisor"]), { ...unsent, shopId: 69, updatedAt: undefined });
  fixture.records.set(JSON.stringify([70, "offline-advisor"]), { ...unsent, shopId: 70, pendingCreates: { contact: { clientRequestId: requestId } } });
  assert.equal(await readROSession(66, "offline-advisor"), null);
  assert.equal(await readROSession(67, "offline-advisor"), null);
  assert.equal((await readROSession(68, "offline-advisor"))?.payload, payload);
  assert.ok((await readROSession(69, "offline-advisor"))?.updatedAt, "legacy arrival-only draft receives a retention timestamp");
  const pending = (await readROSession(70, "offline-advisor"))!;
  assert.equal(pending.pendingCreates?.contact?.clientRequestId, requestId);
  await assert.rejects(removeROSession(pending), "uncertain related writes cannot be discarded");
  await saveROSession({ ...pending, pendingCreates: undefined });
  assert.equal((await readROSession(70, "offline-advisor"))?.pendingCreates?.contact?.clientRequestId, requestId,
    "a stale unsent writer cannot erase a pending creation");
  assert.equal((await saveROSession({ ...pending, payload }, true)).claimed, false,
    "a stale tab cannot submit an RO while a related creation is uncertain");
});

test("draft-only updates preserve photos; other advisors and stale draft identities cannot overwrite or discard", async () => {
  const fixture = offlineRODatabase();
  Object.assign(globalThis, { indexedDB: fixture.indexedDB });
  const unsent = { ...session(), payload: undefined };
  await saveROSession(unsent);
  await saveROSession({ ...unsent, photos: [{ requestId, blob: new Blob(["image"], { type: "image/png" }), name: "arrival.png" }] });
  await saveROSession({ ...unsent, draft: { version: 1, fields: '{"concern":"Rattle"}' } }, false, true);
  const saved = (await readROSession(66, "offline-advisor"))!;
  assert.equal(saved.photos.length, 1);
  assert.equal(saved.draft?.fields, '{"concern":"Rattle"}');
  assert.equal(await readROSession(66, "other-advisor"), null);
  const stale = { ...unsent, handoffRequestId: "different-draft" };
  assert.equal((await saveROSession(stale)).claimed, false);
  await assert.rejects(removeROSession(stale));
  await removeROSession(saved);
  assert.equal(await readROSession(66, "offline-advisor"), null);
});

test("only explicit confirmed official RO responses are successful", () => {
  assert.equal(confirmedRO(success)?.workOrderNumber, 18427);
  for (const value of [null, {}, { ...success, ok: false }, { ...success, pendingVerification: true },
    { ...success, workOrderNumber: "18427" }, { ...success, workOrderNumber: 0 }, { ...success, workOrderNumber: 2.4 },
    { ...success, workOrderId: "local-visit" }, { ...success, workOrderId: undefined }]) assert.equal(confirmedRO(value), null);
});
test("bounded arrival files and navigation cannot accept scripts or protocol-relative redirects", () => {
  assert.equal(photoAllowed(new Blob(["photo"], { type: "image/jpeg" })), true);
  assert.equal(photoAllowed(new Blob(["photo"], { type: "image/svg+xml" })), false);
  assert.equal(photoAllowed(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "image/png" })), false);
  assert.equal(photoAllowed(new Blob([], { type: "image/png" })), false);
  assert.equal(safeLocalHref("/dashboard/workflow?visitId=123"), true);
  for (const value of ["//attacker.test", "/\\attacker.test", "javascript:alert(1)", "/\n/attacker", "https://other.test"]) assert.equal(safeLocalHref(value), false);
});
test("exact payload is persisted before provider write, confirmed result before completion", async () => {
  const events: string[] = [];
  let saved: ROSession | undefined;
  const result = await submitFrozenRO(session(), false, async (path, body) => {
    assert.equal(path, "/api/dashboard/protractor/create-work-order");
    assert.deepEqual(body, { ...JSON.parse(payload), expectedShopId: 66 });
    assert.equal(saved?.payload, payload);
    events.push("post"); return { ok: true, data: success };
  }, async value => { saved = value; events.push(value.result ? "confirmed" : "frozen"); });
  assert.deepEqual(events, ["frozen", "post", "confirmed"]);
  assert.deepEqual(result.result, confirmedRO(success));
});
test("storage failure blocks all provider writes", async () => {
  let writes = 0;
  await assert.rejects(submitFrozenRO(session(), false, async () => { writes++; return { ok: true, data: success }; },
    async () => { throw new Error("quota"); }), /quota/);
  assert.equal(writes, 0);
});
test("lost response and malformed 200 preserve original request; explicit verification adds only recoveryOnly", async () => {
  for (const initial of ["lost", "malformed", "pending", "http-error"]) {
    const requests: unknown[] = [];
    let saved = session();
    const post: JsonPost = async (_path, body) => {
      requests.push(body);
      if (requests.length === 1) {
        if (initial === "lost") throw new Error("network disconnected");
        return { ok: initial !== "http-error", data: initial === "pending" ? { pendingVerification: true } : { workOrderNumber: 18427 } };
      }
      return { ok: true, data: success };
    };
    await assert.rejects(submitFrozenRO(saved, false, post, async value => { saved = value; }));
    assert.equal(saved.payload, payload);
    assert.equal(saved.result, undefined);
    const recovered = await submitFrozenRO(saved, true, post, async value => { saved = value; });
    assert.deepEqual(requests[1], { ...JSON.parse(payload), expectedShopId: 66, recoveryOnly: true });
    assert.equal(recovered.result?.workOrderNumber, 18427);
    assert.equal(JSON.parse(recovered.payload!).clientRequestId, requestId);
  }
});
test("a confirmed outcome never invokes creation again, even on verification", async () => {
  const value = { ...session(), result: confirmedRO(success)! };
  const result = await submitFrozenRO(value, true, async () => { throw new Error("must not POST"); }, async () => { throw new Error("must not replace"); });
  assert.equal(result, value);
});
