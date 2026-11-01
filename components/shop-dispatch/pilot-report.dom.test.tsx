/** Offline: NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node --import tsx components/shop-dispatch/pilot-report.dom.test.tsx */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { PilotOperation, PilotResponse } from "./use-pilot-inspection";

async function main() {
  const require = createRequire(`${process.cwd()}/components/shop-dispatch/pilot-report.dom.test.tsx`);
  require.extensions[".css"] = module => {
    module.exports = { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
  };
  const dom = new JSDOM("<div id='root'></div>", { url: "https://offline.invalid" });
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document,
    sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });
  const { PilotInspectionPanel } = await import("./PilotInspectionPanel");
  const linkId = "a".repeat(64), otherLinkId = "b".repeat(64);
  const option = { version: 7, linkId, expiresAt: "2099-01-01T00:00:00.000Z" };
  const base: PilotResponse = {
    enabled: true, canSend: true, evidenceRevision: 1, workOrderGuid: "work-order",
    operation: null, candidates: [{ sheet: "s", item: "brakes", name: "Brake wear", rating: "red" }],
    reportOptions: [option, { ...option, version: 8, linkId: otherLinkId },
      { ...option, version: 1, expiresAt: "2001-01-01T00:00:00.000Z" }],
  };
  let status = structuredClone(base), losePreview = false, rejectPreview = false;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert(String(input).startsWith("/api/shop-dispatch/inspection/pilot"), "pilot endpoint only");
    assert.equal(init?.credentials, "include");
    if (!init?.body) return Response.json(status);
    const bytes = String(init.body), body = JSON.parse(bytes);
    requests.push(bytes);
    if (body.action === "preview") {
      if (rejectPreview) return Response.json({ error: "Selected findings must exactly equal published report findings" }, { status: 409 });
      if (losePreview) { losePreview = false; throw Error("Lost preview response"); }
      const operation: PilotOperation = {
        id: body.requestId, visitId: "visit", workOrderGuid: "work-order", evidenceRevision: 1,
        state: "preview", acknowledged: false, observedAt: null, recoveryAllowed: false,
        lines: [{ key: "s/brakes", title: "Brake wear", result: "Needs attention", notes: "" }],
        ...(body.publishedReport ? { publishedReport: {
          ...body.publishedReport, expiresAt: option.expiresAt, url: "https://offline.invalid/report?v=7",
          reportDigest: "c".repeat(64), destination: "inspection-line-notes" as const, clickability: "unverified" as const,
        } } : {}),
      };
      status = { ...status, operation };
    } else if (body.action === "send") {
      assert.deepEqual(Object.keys(body).sort(), ["action", "confirmed", "previewId", "visitId"]);
      status = { ...status, operation: { ...status.operation!, state: "confirmed" } };
    } else assert.equal(body.action, "reconcile");
    return Response.json(status);
  };
  const container = document.getElementById("root")!;
  let root = createRoot(container);
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const render = async (blocked = false) => {
    await act(async () => root.render(<PilotInspectionPanel visitId="visit" shopId={66} evidenceRevision={1} blocked={blocked} />));
    await flush();
  };
  const button = (text: string) => {
    const result = [...container.querySelectorAll("button")].find(node => node.textContent === text);
    assert(result, text); return result;
  };
  const click = async (text: string) => { await act(async () => button(text).click()); await flush(); };
  const checkbox = (text: string) => {
    const label = [...container.querySelectorAll("label")].find(node => node.textContent?.includes(text));
    const input = label?.querySelector("input"); assert(input, text); return input;
  };
  const check = async (text: string) => { await act(async () => checkbox(text).click()); await flush(); };
  const fresh = async () => {
    await act(async () => root.unmount());
    sessionStorage.clear(); status = structuredClone(base); requests.length = 0;
    root = createRoot(container); await render();
  };
  await render();
  assert.equal(checkbox("Include existing").checked, false, "explicit default off");
  await check("Brake wear");
  await click("Preview selected saved findings");
  assert(!("publishedReport" in JSON.parse(requests[0])), "legacy findings-only payload unchanged");
  await check("I reviewed");
  await check("Include existing");
  assert(!container.textContent?.includes("2. Review risk"), "report opt-in invalidates frozen preview and acknowledgment");
  assert.equal(container.querySelectorAll("select option").length, 2, "expired links excluded");
  await click("Preview selected saved findings");
  assert.deepEqual(JSON.parse(requests.at(-1)!).publishedReport, { version: 7, linkId }, "reference has no extra option fields");
  assert(container.textContent?.includes("https://offline.invalid/report?v=7"));
  assert(container.textContent?.includes("inspection-line-notes"));
  assert(container.textContent?.includes("Protractor clickability remains unverified"));
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = JSON.stringify([8, otherLinkId]);
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert(!container.textContent?.includes("2. Review risk"), "version/link change invalidates preview");
  await click("Check pilot status");
  assert(!container.textContent?.includes("2. Review risk"), "status cannot resurrect edited preview");
  await click("Preview selected saved findings");
  assert.deepEqual(JSON.parse(requests.at(-1)!).publishedReport, { version: 8, linkId: otherLinkId });
  await check("I reviewed");
  window.confirm = () => true;
  await click("Send saved findings");
  assert(container.textContent?.includes("Confirmed · exact readback"));
  assert(container.querySelector('[aria-label="Frozen published report"]'), "receipt retains report metadata");
  const count = requests.length;
  await click("Check pilot status");
  assert.equal(requests.length, count, "status never sends");
  assert(!container.textContent?.includes("Include existing"), "admission locks selection");

  await fresh();
  await check("Brake wear"); await check("Include existing");
  losePreview = true;
  await click("Preview selected saved findings");
  assert(container.textContent?.includes("Pending · do not resend"));
  assert(!container.textContent?.includes("Include existing"), "uncertainty locks selection");
  const original = requests.at(-1)!;
  await render(true);
  assert.equal(button("Retry exact preview request (not a send)").disabled, true, "blocked lock applies to retry");
  await render(false);
  await click("Retry exact preview request (not a send)");
  assert.equal(requests.at(-1), original, "retry bytes exactly match original report reference, findings and request ID");
  assert(container.textContent?.includes("2. Review risk"));

  await fresh();
  await check("Brake wear"); await check("Include existing");
  rejectPreview = true;
  await click("Preview selected saved findings");
  assert(container.querySelector('[role="alert"]')?.textContent?.includes("Selected findings must exactly equal"));
  assert.equal(requests.length, 1, "mismatch never silently retries without report");
  assert(JSON.parse(requests[0]).publishedReport);
  rejectPreview = false;

  await fresh();
  status = { ...status, reportOptions: [] };
  await click("Check pilot status");
  assert(checkbox("Include existing").disabled);
  assert(container.textContent?.includes("Publish and create a link in customer release first"));
  await check("Brake wear");
  await click("Preview selected saved findings");
  assert(!JSON.parse(requests.at(-1)!).publishedReport, "no-links state still permits findings-only preview");
  await act(async () => root.unmount());
  dom.window.close();
  console.log("Pilot report offline DOM checks passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
