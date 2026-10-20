import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applySharedReceipt, draftFence, handoffHref, sharedSnapshot, sharedSnapshotMatches, sharedSnapshotSaved, validSharedDraft, writeSharedDraft, type SharedDraft } from "../components/ro-shared-draft-client";
import { convertOdometer, parseOdometerSuggestion } from "../components/ro-odometer";
import type { ROSession } from "../components/ro-session-store";

function fixture() {
  const deviceId = randomUUID(), id = randomUUID();
  const session: ROSession = { shopId: 999, actorKey: "synthetic-advisor", handoffRequestId: id,
    draft: { version: 1, fields: JSON.stringify({ concern: "Synthetic fixture concern" }) },
    photos: [{ requestId: randomUUID(), name: "original.png", blob: new Blob(["synthetic bytes"], { type: "image/png" }) }],
    shared: { id, revision: 4, deviceId } };
  const snapshot = sharedSnapshot(session);
  const remote: SharedDraft = { id, revision: 5, ownerDeviceId: deviceId, updatedAt: new Date().toISOString(),
    session: snapshot.session, photos: snapshot.photos.map(p => ({ ...p, saved: true })) };
  return { session, remote, deviceId };
}
test("QR has only an opaque selector, not auth or customer data", () => {
  const { session } = fixture();
  const url = new URL(handoffHref("https://offline.example.invalid", session.handoffRequestId));
  assert.equal(url.pathname, "/dashboard/check-in");
  assert.deepEqual([...url.searchParams.keys()], ["draft"]);
  assert.equal(url.searchParams.get("draft"), session.handoffRequestId);
  assert.throws(() => handoffHref(url.origin, "advisor@example.invalid"));
});
test("snapshot excludes binary and fence but retains frozen recovery state", () => {
  const { session } = fixture();
  session.pendingCreates = { contact: { clientRequestId: randomUUID(), firstName: "Synthetic" } };
  session.payload = JSON.stringify({ clientRequestId: randomUUID() });
  const snapshot = sharedSnapshot(session);
  assert.equal("shared" in snapshot.session, false);
  assert.equal("blob" in snapshot.photos[0], false);
  assert.equal("serverSaved" in snapshot.photos[0], false);
  assert.deepEqual(snapshot.session.pendingCreates, session.pendingCreates);
  assert.equal(snapshot.session.payload, session.payload);
  assert.deepEqual(draftFence(session), { _guidedDraft: session.shared });
});
test("only matching same-actor/shop valid bounded server receipts are accepted", () => {
  const { session, remote, deviceId } = fixture();
  assert.equal(validSharedDraft(remote, session.shopId, session.actorKey), true);
  assert.equal(validSharedDraft(remote, 998, session.actorKey), false);
  assert.equal(validSharedDraft(remote, 999, "other-advisor"), false);
  assert.equal(validSharedDraft({ ...remote, photos: Array(13).fill(remote.photos[0]) }, 999, session.actorKey), false);
  assert.equal(validSharedDraft({ ...remote, photos: [{ ...remote.photos[0], size: 4 * 1024 * 1024 + 1 }] }, 999, session.actorKey), false);
  const confirmed = applySharedReceipt(session, remote, deviceId);
  assert.equal(confirmed.photos[0].serverSaved, true);
  assert.equal(confirmed.shared?.revision, 5);
  assert.equal(confirmed.photos[0].blob, session.photos[0].blob);
  assert.throws(() => applySharedReceipt(session, { ...remote, ownerDeviceId: randomUUID() }, deviceId), /another device/);
  assert.throws(() => applySharedReceipt(session, { ...remote, id: randomUUID() }, deviceId));
});
test("unsynced photos never inherit a server-saved claim", () => {
  const { session, remote, deviceId } = fixture();
  session.photos[0].serverSaved = true;
  remote.photos[0].saved = false;
  assert.equal(applySharedReceipt(session, remote, deviceId).photos[0].serverSaved, false);
});
test("server native confirmation is merged and never dropped by an older browser snapshot", () => {
  const { session, remote, deviceId } = fixture();
  remote.session.payload = JSON.stringify({ clientRequestId: randomUUID(), concernText: "Synthetic" });
  remote.session.result = { workOrderId: randomUUID(), workOrderNumber: 18427, packagesWithoutLines: [] };
  const confirmed = applySharedReceipt(session, remote, deviceId);
  assert.deepEqual(confirmed.result, remote.session.result);
  assert.equal(confirmed.payload, remote.session.payload);
  assert.equal(sharedSnapshotSaved(confirmed, remote), true);
  assert.equal(sharedSnapshotSaved({ ...confirmed, draft: { version: 1, fields: "new device-only edit" } }, remote), false);
  remote.photos[0].saved = false;
  assert.equal(sharedSnapshotMatches(confirmed, remote), true);
  assert.equal(sharedSnapshotSaved(confirmed, remote), false);
});
test("a lost save acknowledgement is resolved by exact-snapshot read, never mutation replay", async () => {
  const { session, remote, deviceId } = fixture();
  const originalFetch = globalThis.fetch, methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "POST") throw new Error("Synthetic response lost after commit");
    return Response.json({ draft: remote });
  };
  try {
    assert.equal((await writeSharedDraft("save", session, deviceId)).revision, remote.revision);
    assert.deepEqual(methods, ["POST", "GET"]);
  } finally { globalThis.fetch = originalFetch; }
});
test("a mismatching read after lost save never counts as synchronized", async () => {
  const { session, remote, deviceId } = fixture();
  remote.session.draft = { version: 1, fields: "different server details" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") throw new Error("Synthetic disconnected write");
    return Response.json({ draft: remote });
  };
  try { await assert.rejects(writeSharedDraft("save", session, deviceId), /not confirmed/); }
  finally { globalThis.fetch = originalFetch; }
});
test("mock model results: clear, trip-only, blurry, km and unknown", () => {
  const clear = { reading: 84617, unit: "miles", confidence: "high", kind: "odometer" };
  assert.deepEqual(parseOdometerSuggestion(clear), clear);
  for (const kind of ["trip", "unreadable"])
    assert.equal(parseOdometerSuggestion({ reading: null, unit: "unknown", confidence: "low", kind }).reading, null);
  for (const unit of ["kilometers", "unknown"])
    assert.equal(parseOdometerSuggestion({ ...clear, unit }).unit, unit);
});
test("malformed/guessed/partial/trip digits are rejected, not coerced", () => {
  const valid = { reading: 84617, unit: "miles", confidence: "high", kind: "odometer" };
  for (const invalid of [null, "84617", { ...valid, reading: "84617" }, { ...valid, reading: -1 },
    { ...valid, reading: 123.4 }, { ...valid, reading: 10_000_000 }, { ...valid, unit: "mi" },
    { ...valid, confidence: "probably" }, { ...valid, kind: "trip" }, { ...valid, reading: null },
    { ...valid, guessed: true }]) assert.throws(() => parseOdometerSuggestion(invalid));
});
test("explicit mileage conversion uses shop units and whole-unit rounding", () => {
  assert.equal(convertOdometer(104201, "kilometers", "miles"), 64747);
  assert.equal(convertOdometer(64748, "miles", "kilometers"), 104202);
  assert.equal(convertOdometer(84617, "miles", "miles"), 84617);
  assert.equal(convertOdometer(0, "kilometers", "miles"), 0);
  assert.throws(() => convertOdometer(9_999_999, "miles", "kilometers"));
});
