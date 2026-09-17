/** Real DashboardClient lifecycle, with offline fetches and unrelated panels stubbed. */
import assert from "node:assert/strict";
import Module from "node:module";
import { JSDOM } from "jsdom";
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM("<!doctype html><div id='root'></div>", {
  url: "http://localhost/dashboard",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const originalLoad = (Module as any)._load;
const emptyPanel = () => null;
(Module as any)._load = function(request: string, parent: any, isMain: boolean) {
  if (request.startsWith("@/components/")) {
    return { __esModule: true, default: emptyPanel, VinSpecsTooltip: emptyPanel };
  }
  if (request === "next/link") {
    return { __esModule: true, default: ({ children, href }: any) => React.createElement("a", { href }, children) };
  }
  if (request === "@/lib/plan-prefetch") return { queueMultiplePrefetch() {}, queuePrefetch() {} };
  if (request === "@/lib/print-sticker") return { buildStickerPrintHtml() { throw new Error("Printing is outside this fixture"); } };
  return originalLoad.call(this, request, parent, isMain);
};

type Pending = { signal?: AbortSignal | null; resolve: (response: Response) => void };
const pending: Pending[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input: any, init?: RequestInit): Promise<Response> => {
  assert.ok(String(input).startsWith("/api/dashboard/data?"), `Unexpected offline fetch ${input}`);
  // Deliberately do not reject when aborted: even a late response from a
  // non-cooperative transport must never overwrite the replayed mount.
  return new Promise(resolve => pending.push({ signal: init?.signal, resolve }));
};

async function main() {
  const DashboardClient = require("../app/dashboard/DashboardClient").default;
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  const initialData = { rows: [], user: { shopId: 432 }, shopId: 432, smsType: "autoflow", enabledFeatures: [] };
  const response = (name: string) => new Response(JSON.stringify({
    ...initialData,
    dashboardUpdateToken: "0:0:1:1",
    rows: [{
      displayName: name,
      displayVin: "1HGCM82633A004352",
      displayVehicle: "2020 Honda Accord",
      displayMiles: 42000,
      displayRO: "100",
      displayStatus: "Servicing",
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    await act(async () => {
      root.render(React.createElement(StrictMode, null, React.createElement(DashboardClient, { initialData })));
    });
    assert.equal(pending.length, 2, "Strict Mode starts a fresh fetch after effect replay");
    assert.equal(pending[0].signal?.aborted, true, "replayed initial fetch is aborted");
    assert.equal(pending[1].signal?.aborted, false, "replacement fetch remains live");
    await act(async () => { pending[1].resolve(response("Post-replay vehicle")); });
    assert.match(container.textContent || "", /Post-replay vehicle/);
    const refresh = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Refresh");
    assert.ok(refresh && !refresh.disabled, "refreshing clears after the replacement fetch");
    await act(async () => { pending[0].resolve(response("Stale aborted vehicle")); });
    assert.doesNotMatch(container.textContent || "", /Stale aborted vehicle/);
    assert.match(container.textContent || "", /Post-replay vehicle/);
    console.log("  ✓ StrictMode replay commits dashboard rows, clears refreshing, and rejects late aborted rows");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.fetch = originalFetch;
    (Module as any)._load = originalLoad;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});