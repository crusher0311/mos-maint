import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { JSDOM } from "jsdom";
import { offlineRODatabase } from "./ro-recovery.offline-fixture";
import NewWorkOrderModal from "./NewWorkOrderModal";

test("actual shared modal preserves guided followups, unanswered questions, multiple concerns, notes and job payload", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://mos.invalid" });
  const fixture = offlineRODatabase();
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, indexedDB: fixture.indexedDB, IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const requests: Array<{ path: string; body?: Record<string, any> }> = [];
  const originalFetch = globalThis.fetch;
  let confirmedNumber = 0;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body });
    if (path === "/api/dashboard/protractor/dvi-handoff") return Response.json({ enabled: false, shopId: 77, actorKey: "advisor-fixture" });
    if (path === "/api/settings/create-ro") return Response.json({ customerFields: {}, vehicleFields: {}, marketingSources: [] });
    if (path === "/api/dashboard/concern-assistant") {
      if (body.action === "followup") return Response.json({ questions: ["When is it loud?", "Which corner?"], conversationId: "conversation-offline" });
      if (body.action === "review") return Response.json({ questions: ["At what speed?", "When is it loud?"] });
      if (body.action === "cleanup") return Response.json({ cleanedText: "Front-left rattle over bumps below 25 mph." });
    }
    if (path.startsWith("/api/dashboard/protractor/contacts?")) return Response.json({ contacts: [{ id: "contact-fixture", firstName: "Mara", lastName: "Ortiz", fileAs: "Ortiz, Mara", company: "", phone: "555-0107", email: "" }] });
    if (path.startsWith("/api/dashboard/protractor/vehicles?")) return Response.json({ vehicles: [{ id: "vehicle-fixture", vin: "1TESTOFFLINE000001", year: 2018, make: "Mazda", model: "CX-5", submodel: "", engine: "", color: "", plate: "OFFLINE", odometer: 83291 }] });
    if (path.startsWith("/api/dashboard/protractor/deferred-work")) return Response.json({ items: [] });
    if (path.startsWith("/api/jobs/search")) return Response.json({ results: [] });
    if (path.startsWith("/api/dashboard/protractor/canned-jobs")) return Response.json({ jobs: [{ title: "Road-test diagnosis", name: "Road-test diagnosis", code: "DIAG-RT", description: "Confirm the customer concern" }] });
    if (path === "/api/dashboard/protractor/create-work-order") return Response.json({ ok: true, workOrderId: "1809c214-b117-446e-87b4-d361893cf458", workOrderNumber: 18427 });
    throw new Error(`Unexpected offline route ${path}`);
  }) as typeof fetch;
  const root = createRoot(document.getElementById("root")!);
  async function settle() { for (let i = 0; i < 12; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 3)); }); }
  function button(text: string) {
    const result = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === text);
    assert.ok(result, `Missing button "${text}". Page: ${document.body.textContent}`);
    return result;
  }
  async function click(text: string) { await act(async () => button(text).click()); await settle(); }
  async function change(element: Element | null, value: string) {
    assert.ok(element);
    await act(async () => Simulate.change(element, { target: { value } } as any));
  }
  try {
    await act(async () => root.render(React.createElement(NewWorkOrderModal, { isOpen: true, onClose() {}, onCreated: number => { confirmedNumber = number; } })));
    await settle();
    await change(document.querySelector("textarea"), "Rattle over bumps");
    await click("Build Concern Write-up");
    await change(document.querySelectorAll('input[placeholder="Type answer..."]')[0], "Over bumps");
    await click("More Questions");
    const review = requests.find(request => request.body?.action === "review")!.body!;
    assert.deepEqual(review.answeredQuestions, [{ question: "When is it loud?", response: "Over bumps" }]);
    assert.ok(document.body.textContent?.includes("Which corner?"), "Unanswered question remains visible");
    assert.equal(document.querySelectorAll('input[placeholder="Type answer..."]').length, 2, "Duplicate question is not resurfaced");
    await change(document.querySelectorAll('input[placeholder="Type answer..."]')[0], "Front left");
    await change(document.querySelectorAll('input[placeholder="Type answer..."]')[1], "Below 25 mph");
    await click("Generate Write-up");
    const cleanup = requests.find(request => request.body?.action === "cleanup")!.body!;
    assert.equal(cleanup.conversationId, "conversation-offline");
    assert.deepEqual(cleanup.exchanges, [
      { question: "When is it loud?", response: "Over bumps" },
      { question: "Which corner?", response: "Front left" },
      { question: "At what speed?", response: "Below 25 mph" },
    ]);
    await click("Add Another Concern");
    await change(document.querySelector("textarea"), "Brake pedal pulses");
    await click("Continue to Customer");
    await change(document.querySelector('input[placeholder*="name"]'), "Ortiz");
    await click("Search");
    const customer = [...document.querySelectorAll("button")].find(element => element.textContent?.includes("Mara") && element.textContent.includes("Ortiz"));
    assert.ok(customer); await act(async () => customer.click()); await settle();
    const vehicle = [...document.querySelectorAll("button")].find(element => element.textContent?.includes("2018 Mazda CX-5"));
    assert.ok(vehicle); await act(async () => vehicle.click()); await settle();
    await change(document.querySelector('input[placeholder="Enter current mileage..."]'), "84217");
    await click("Next");
    await change(document.querySelector("textarea"), "Customer waiting; call before repairs.");
    await click("Next: Add Jobs");
    // Existing canned-job selection remains part of this same modal.
    await click("Search");
    const add = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === "Add");
    assert.ok(add, `Canned job Add button missing: ${document.body.textContent}`);
    await act(async () => add.click()); await settle();
    await click("Create Work Order with 1 Job");
    const creation = requests.find(request => request.path.endsWith("create-work-order"))!.body!;
    assert.deepEqual(creation.concerns, ["Front-left rattle over bumps below 25 mph.", "Brake pedal pulses"]);
    assert.equal(creation.note, "Customer waiting; call before repairs.");
    assert.equal(creation.mileage, 84217);
    assert.equal(creation.servicePackages.length, 1);
    assert.match(creation.clientRequestId, /^[0-9a-f-]{36}$/);
    assert.equal(confirmedNumber, 18427);
    assert.ok(document.body.textContent?.includes("RO #18427 confirmed"));
    assert.equal([...document.querySelectorAll("button")].some(element => element.textContent?.includes("Continue to DVI")), false, "No-entitlement completion is normal Done, not DVI");
    assert.ok(button("Done"));
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close();
  }
});
