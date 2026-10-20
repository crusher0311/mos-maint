// Offline synthetic fixture. No production API, credentials or provider client.
import React, { useEffect } from "react";
import DispatchPilot from "../../components/shop-dispatch/DispatchPilot";

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
};
declare global { interface Window { __newROFixture: FixtureState } }
export function createNewROFixture(params: URLSearchParams, onImported: () => string) {
  const state: FixtureState = { calls: [], blocked: [], enabled: !params.has("newRONoDvi"), shopId: 999, actorKey: "offline-mara-advisor",
    photoAttempts: 0, handoffAttempts: 0 };
  window.__newROFixture = state;
  const receiptKey = () => `offline-new-ro-receipt:${state.shopId}:${state.actorKey}`;
  return async (path: string, init?: RequestInit): Promise<Response | null> => {
    if (!path.startsWith("/api/dashboard/") && path !== "/api/settings/create-ro") return null;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push({ path, body });
    if (path === "/api/settings/create-ro") return Response.json({ customerFields: {}, vehicleFields: {}, marketingSources: [] });
    if (path === "/api/dashboard/protractor/dvi-handoff") {
      if (!body) return Response.json({ enabled: state.enabled, shopId: state.shopId, actorKey: state.actorKey });
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
