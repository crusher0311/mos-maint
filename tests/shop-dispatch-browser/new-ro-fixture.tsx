// Offline synthetic fixture. No production API, credentials or provider client.
import React, { useEffect } from "react";
import DispatchPilot from "../../components/shop-dispatch/DispatchPilot";
import { createSharedCheckInFixture, reserveSharedCheckInFixture } from "./shared-check-in-fixture";

const WORK_ORDER_ID = "1809c214-b117-446e-87b4-d361893cf458";
export const NEW_RO_NUMBER = 18427;
export type FixtureState = {
  calls: Array<{ path: string; body: Record<string, any> | null }>;
  blocked: string[];
  enabled: boolean;
  shopId: number;
  actorKey: string;
  photoAttempts: number;
  handoffAttempts: number;
  nativeSends: Record<string, number>;
  distanceUnit: "miles" | "kilometers";
};
declare global { interface Window { __newROFixture: FixtureState } }
export function createNewROFixture(params: URLSearchParams, onImported: () => string) {
  const state: FixtureState = { calls: [], blocked: [], enabled: !params.has("newRONoDvi"), shopId: 999, actorKey: "offline-mara-advisor",
    photoAttempts: 0, handoffAttempts: 0, nativeSends: {}, distanceUnit: params.has("shopKm") ? "kilometers" : "miles" };
  window.__newROFixture = state;
  const shared = createSharedCheckInFixture(state.shopId, state.actorKey);
  const receiptKey = () => `offline-new-ro-receipt:${state.shopId}:${state.actorKey}`;
  return async (path: string, init?: RequestInit): Promise<Response | null> => {
    if (params.has("newROShared")) {
      const result = await shared(path, init); if (result) {
        state.calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (init?.body && params.has("loseDraftAck")) {
          const action = JSON.parse(String(init.body)).action;
          const key = `offline-lost-draft-ack:${action}`;
          if (["create", "save", "photo", "claim"].includes(action) && result.ok && !sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, "1"); throw new Error("Synthetic draft response lost after commit.");
          }
        }
        return result;
      }
      if (path === "/api/dashboard/protractor/vin-plate-ocr") {
        state.calls.push({ path, body: null });
        return Response.json({ result: params.has("newROPlateScan") ? { plate: "FIX147", state: "Texas", confidence: "high" } :
          { vin: "1HGCM82633A004352", confidence: "high" } });
      }
      if (path.startsWith("/api/vin/decode?")) {
        state.calls.push({ path, body: null });
        return Response.json({ decoded: true, year: 2016, make: "Honda", model: "Accord", engine: "2.4 L", transmission: "CVT" });
      }
      if (path === "/api/vin/plate-lookup") {
        state.calls.push({ path, body: JSON.parse(String(init?.body)) });
        return Response.json({ success: true, vin: "1HGCM82633A004352", year: 2016, make: "Honda", model: "Accord" });
      }
      if (path === "/api/dashboard/protractor/odometer-ocr") {
        const body = JSON.parse(String(init?.body));
        state.calls.push({ path, body });
        const admission = reserveSharedCheckInFixture(state.shopId, state.actorKey, body, `scan:${body.photoRequestId}`);
        if (admission?.response) return admission.response;
        if (admission?.send) state.nativeSends.ocr = (state.nativeSends.ocr ?? 0) + 1;
        const mode = params.get("odometer");
        if (mode === "failure") return Response.json({ error: "Synthetic OCR unavailable after reservation" }, { status: 503 });
        const result = mode === "trip" ? { reading: null, unit: "miles", confidence: "high", kind: "trip" } :
          mode === "blurry" ? { reading: null, unit: "unknown", confidence: "low", kind: "unreadable" } :
          mode === "malformed" ? { reading: "probably 84617", unit: "mi", confidence: "high" } :
          { reading: 104201, unit: mode === "km" ? "kilometers" : mode === "unknown" ? "unknown" : "miles", confidence: "high", kind: "odometer" };
        admission?.complete({ result });
        if (mode === "lostAck") throw new Error("Synthetic OCR response lost after completion");
        return Response.json({ result });
      }
    }
    if (!path.startsWith("/api/dashboard/") && path !== "/api/settings/create-ro") return null;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push({ path, body });
    if (path === "/api/settings/create-ro") return Response.json({ customerFields: {}, vehicleFields: {}, marketingSources: [] });
    if (path === "/api/dashboard/protractor/dvi-handoff") {
      if (!body) return Response.json({ enabled: state.enabled, shopId: state.shopId, actorKey: state.actorKey,
        ...(params.has("newROShared") ? { sharedDrafts: { version: 1 }, odometerScan: { version: 1 },
          distanceUnit: state.distanceUnit } : {}) });
      state.handoffAttempts++;
      if (!state.enabled) return Response.json({ error: "DVI permission unavailable." }, { status: 403 });
      if (params.has("newROHandoffRetry") && state.handoffAttempts === 1) return Response.json({ error: "Synthetic local import temporarily unavailable." }, { status: 503 });
      const visitId = onImported();
      return Response.json({ visitId, href: `/?newRO&newROArrived&visit=${encodeURIComponent(visitId)}&dvi=1` });
    }
    if (path === "/api/dashboard/concern-assistant") {
      if (body.action === "followup") return Response.json({ questions: ["When do you hear the rattle?", "Which corner does it come from?"], conversationId: "offline-concern-1" });
      if (body.action === "review") return Response.json({ questions: ["At what speed?", "When do you hear the rattle?"] });
      if (body.action === "cleanup") return Response.json({ cleanedText: "Customer reports a front-left rattle over bumps below 25 mph." });
    }
    if (path === "/api/dashboard/protractor/create-contact" || path === "/api/dashboard/protractor/create-vehicle") {
      if (body.expectedShopId !== state.shopId) return Response.json({ error: "Shop context changed." }, { status: 409 });
      const kind = path.endsWith("create-contact") ? "contact" : "vehicle";
      const admission = reserveSharedCheckInFixture(state.shopId, state.actorKey, body, kind);
      if (admission?.response) return admission.response;
      if (admission?.send) {
        state.nativeSends[kind] = (state.nativeSends[kind] ?? 0) + 1;
        const result = { success: true, [`${kind}Id`]: `${kind}-offline-created` };
        admission.complete(result);
        if (params.has("loseRelatedAck")) throw new Error("Synthetic related response lost after confirmed reservation");
        return Response.json(result);
      }
      const key = `offline-related:${kind}:${state.shopId}:${state.actorKey}`;
      const receipt = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (receipt && JSON.stringify(receipt) !== JSON.stringify(body)) throw new Error("Retry changed the frozen related request");
      sessionStorage.setItem(key, JSON.stringify(body));
      // Synthetic provider committed before the first response was lost.
      if (!receipt) throw new Error("Disconnected after provider accepted related creation");
      return Response.json({ success: true, [`${kind}Id`]: `${kind}-offline-created` });
    }
    if (path.startsWith("/api/dashboard/protractor/contacts?")) return Response.json({ contacts: [
      { id: "contact-offline", firstName: "Mara", lastName: "Ortiz", fileAs: "Ortiz, Mara", company: "", phone: "(555) 010-0147", email: "mara@example.test" },
    ] });
    if (path.startsWith("/api/dashboard/protractor/vehicles?")) return Response.json({ vehicles: [
      { id: "vehicle-offline", vin: "1TESTOFFLINE000001", year: 2018, make: "Mazda", model: "CX-5", submodel: "Touring", engine: "2.5 L", color: "Deep crystal blue", plate: "TEST-147", odometer: 83291 },
    ] });
    if (path.startsWith("/api/dashboard/protractor/deferred-work")) return Response.json({ items: [] });
    if (path.startsWith("/api/dashboard/protractor/canned-jobs")) return Response.json({ jobs: [{ title: "Road-test diagnosis", description: "Confirm reported rattle", code: "DIAG-RT" }] });
    if (path === "/api/dashboard/protractor/create-work-order") {
      if (body.expectedShopId !== state.shopId) return Response.json({ error: "Shop context changed." }, { status: 409 });
      const admission = reserveSharedCheckInFixture(state.shopId, state.actorKey, body, "ro");
      if (admission?.response) return admission.response;
      if (admission?.send) {
        state.nativeSends.ro = (state.nativeSends.ro ?? 0) + 1;
        const result = { ok: true, workOrderId: WORK_ORDER_ID, workOrderNumber: NEW_RO_NUMBER, packagesWithoutLines: [] };
        admission.complete(result);
        if (params.has("loseNativeAck")) throw new Error("Synthetic RO response lost after server confirmation");
        return Response.json(result);
      }
      const receipt = JSON.parse(sessionStorage.getItem(receiptKey()) ?? "null");
      if (body.recoveryOnly) {
        const { recoveryOnly: _recovery, ...original } = body;
        if (!receipt || JSON.stringify(receipt.body) !== JSON.stringify(original)) return Response.json({ ok: false, pendingVerification: true }, { status: 202 });
        return Response.json(receipt.result);
      }
      const result = { ok: true, workOrderId: WORK_ORDER_ID, workOrderNumber: NEW_RO_NUMBER,
        packagesWithoutLines: params.has("newROJobWarning") ? [{ title: "Road-test diagnosis", code: "DIAG-RT" }] : [] };
      sessionStorage.setItem(receiptKey(), JSON.stringify({ body, result }));
      if (params.has("newROUncertain")) return Response.json({ ok: false, pendingVerification: true }, { status: 202 });
      if (params.has("newROMalformed")) return Response.json({ workOrderNumber: NEW_RO_NUMBER });
      return Response.json(result);
    }
    if (path.startsWith("/api/dashboard/protractor/arrival-photos")) {
      if (!body) return Response.json({ photos: [{ id: "offline-arrival-1", mime: "image/png", url: "/new-ro-photo.svg" }] });
      state.photoAttempts++;
      if (body._guidedDraft) {
        const key = `offline-shared-check-in:${state.shopId}:${state.actorKey}`, draft = JSON.parse(localStorage.getItem(key)!);
        if (draft.revision !== body._guidedDraft.revision || draft.ownerDeviceId !== body._guidedDraft.deviceId)
          return Response.json({ error: "Synthetic arrival attachment fence changed" }, { status: 409 });
        const photo = { id: `offline-arrival-${body.requestId}`, mime: body.mime, url: "/new-ro-photo.svg" };
        draft.photos = draft.photos.map((p: { requestId: string }) => p.requestId === body.requestId ? { ...p, uploaded: photo } : p);
        draft.revision++;
        localStorage.setItem(key, JSON.stringify(draft));
        if (params.has("loseArrivalAck")) throw new Error("Synthetic attachment response lost after commit");
        return Response.json({ photo });
      }
      if (params.has("newROPhotoRetry") && state.photoAttempts === 1) return Response.json({ error: "Synthetic upload response lost." }, { status: 503 });
      return Response.json({ photo: { id: "offline-arrival-1", mime: body.mime, url: "/new-ro-photo.svg" } });
    }
    state.blocked.push(path);
    throw new Error(`Offline new-RO fixture blocked unexpected request: ${path}`);
  };
}
export function NewROPreview() {
  useEffect(() => {
    if (new URLSearchParams(location.search).has("newROArrived")) return;
    const timer = setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="dispatch-create-new-ro"]');
      if (button && !button.disabled) { button.click(); clearInterval(timer); }
    }, 40);
    return () => clearInterval(timer);
  }, []);
  return <DispatchPilot />;
}
