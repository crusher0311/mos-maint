import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { offlineRODatabase } from "./ro-recovery.offline-fixture";
import { useRORecovery } from "./use-ro-recovery";

test("offline mounted hook: reload recovery, upload-only retry, fresh DVI gate and shop isolation", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://mos.invalid" });
  const fixture = offlineRODatabase();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, indexedDB: fixture.indexedDB, IS_REACT_ACT_ENVIRONMENT: true });
  let shopId = 66;
  let actorKey = "offline-advisor";
  let enabled = true;
  let uploadFails = true;
  let createCount = 0;
  let pending202 = false;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === "/api/dashboard/protractor/dvi-handoff" && !init?.method)
      return Response.json({ shopId, actorKey, enabled });
    const body = JSON.parse(String(init?.body));
    requests.push({ path, body });
    if (path.endsWith("create-work-order")) {
      createCount++;
      if (!body.recoveryOnly) {
        if (pending202) return Response.json({ ok: false, pendingVerification: true }, { status: 202 });
        throw new Error("Disconnected after provider accepted write");
      }
      return Response.json({ ok: true, workOrderId: "1809c214-b117-446e-87b4-d361893cf458", workOrderNumber: 18427 });
    }
    if (path.endsWith("arrival-photos")) {
      if (uploadFails) return Response.json({ error: "temporary" }, { status: 503 });
      return Response.json({ photo: { id: "photo-1", mime: "image/jpeg", url: "/api/arrival-photo/1" } });
    }
    if (path.endsWith("dvi-handoff")) return Response.json({ error: "Local import unavailable" }, { status: 503 });
    throw new Error(`Unexpected offline request ${path}`);
  }) as typeof fetch;
  // FileReader mock reads only this in-memory Blob; no files or network.
  Object.assign(globalThis, { FileReader: class {
    result = ""; onload?: () => void;
    readAsDataURL() { this.result = "data:image/jpeg;base64,cGhvdG8="; this.onload?.(); }
  } });
  let api!: ReturnType<typeof useRORecovery>;
  let callbacks = 0;
  function Harness({ open }: { open: boolean }) { api = useRORecovery(open, () => callbacks++); return React.createElement("div", null, api.ready ? "ready" : "loading"); }
  let root = createRoot(document.getElementById("root")!);
  async function settle() { for (let i = 0; i < 12; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 4)); }); }
  async function mount() { await act(async () => root.render(React.createElement(Harness, { open: true }))); await settle(); }
  try {
    await mount();
    assert.equal(api.ready, true);
    const file = new Blob(["photo"], { type: "image/jpeg" }) as File;
    Object.defineProperty(file, "name", { value: "front-bumper.jpg" });
    await act(async () => { await api.addPhoto(file); });
    assert.equal(api.session?.photos.length, 1);
    const payload = { clientRequestId: "f037c214-b117-446e-87b4-d361893cf458", contactId: "contact", vehicleId: "vehicle", concerns: ["Rattle"], note: "Waiting", servicePackages: [{ title: "Diagnosis" }] };
    await act(async () => { await api.create(payload); });
    assert.equal(createCount, 1);
    assert.match(api.error, /Disconnected/);
    assert.equal(callbacks, 0);
    const frozen = api.session?.payload;
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    await mount();
    assert.equal(api.session?.payload, frozen);
    assert.equal(api.session?.photos[0].name, "front-bumper.jpg");
    await act(async () => { await api.verify(); });
    assert.equal(api.session?.result?.workOrderNumber, 18427);
    assert.equal(callbacks, 1);
    assert.match(api.error, /arrival upload/);
    assert.deepEqual(requests.filter(r => r.path.endsWith("create-work-order"))[1].body, { ...payload, expectedShopId: 66, recoveryOnly: true });
    const countAfterVerification = createCount;
    uploadFails = false;
    await act(async () => { await api.retryPhotos(); });
    assert.equal(createCount, countAfterVerification);
    const uploads = requests.filter(r => r.path.endsWith("arrival-photos"));
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[0].body, uploads[1].body);
    assert.equal(api.session?.photos[0].uploaded?.id, "photo-1");
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    await mount();
    assert.equal(api.session?.result?.workOrderNumber, 18427, "Confirmed result survives reload");
    assert.equal(api.session?.payload, frozen);
    assert.equal(api.session?.photos[0].uploaded?.id, "photo-1");
    enabled = false;
    await act(async () => { await api.continueDvi(); });
    assert.equal(requests.filter(r => r.path.endsWith("dvi-handoff")).length, 0);
    assert.equal(api.enabled, false);
    enabled = true;
    await act(async () => { await api.continueDvi(); });
    assert.match(api.error, /handoff is not confirmed/);
    await act(async () => { await api.continueDvi(); });
    const handoffs = requests.filter(request => request.path.endsWith("dvi-handoff"));
    assert.equal(handoffs.length, 2);
    assert.deepEqual(handoffs[0].body, handoffs[1].body, "DVI retries retain request identity and never repeat creation");
    assert.equal(createCount, countAfterVerification);
    assert.equal(api.session?.result?.workOrderNumber, 18427);
    await act(async () => root.render(React.createElement(Harness, { open: false })));
    shopId = 89;
    await mount();
    assert.equal(api.session?.shopId, 89);
    assert.equal(api.session?.payload, undefined);
    assert.equal(api.session?.photos.length, 0);
    enabled = false; pending202 = true;
    await act(async () => { await api.create({ clientRequestId: "a037c214-b117-446e-87b4-d361893cf458", concerns: ["Offline 202 case"] }); });
    assert.equal(api.session?.result, undefined, "HTTP 202 is not success");
    assert.match(api.error, /not confirmed/);
    await act(async () => { await api.verify(); });
    const verifiedResult = api.session?.result as { workOrderNumber: number } | undefined;
    assert.equal(verifiedResult?.workOrderNumber, 18427);
    assert.equal(api.enabled, false, "No entitlement does not block a normal RO");
    const countBeforeDone = createCount;
    let finished = false;
    await act(async () => { finished = await api.finish(); });
    assert.equal(finished, true);
    assert.equal(createCount, countBeforeDone);
    assert.ok(fixture.records.get(JSON.stringify([66, "offline-advisor"])), "Other shop's frozen outcome must remain retained");
    await act(async () => root.render(React.createElement(Harness, { open: false })));
    shopId = 66; actorKey = "different-advisor";
    await mount();
    assert.equal(api.session?.payload, undefined);
    assert.equal(api.session?.photos.length, 0);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
