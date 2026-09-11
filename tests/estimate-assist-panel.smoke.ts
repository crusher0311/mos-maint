/**
 * Offline UI checks for recommendation review in EstimateAssistPanel.
 *
 * The resolver and builder are mocked: this verifies the dashboard review
 * contract without provider writes or Mongo.
 *
 * Run: `npx tsx tests/estimate-assist-panel.smoke.ts`
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body></body></html>",
  { url: "http://localhost/dashboard/estimate-audit", pretendToBeVisual: true },
);

(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle;
(dom.window as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import EstimateAssistPanel from "../components/EstimateAssistPanel";

type FetchCall = { input: string | URL | Request; init?: RequestInit };
type FetchResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function json(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const report = {
  workOrderId: "wo-1",
  workOrderNumber: "1001",
  provider: "protractor",
  smsWorkOrderId: "1f6d40c3-86da-4c9d-a49f-8f79db7a1222",
  vehicleDisplay: "2020 Honda Civic",
  vehicle: { vin: "1HGC M82633A004352".replace(/\s/g, ""), year: 2020, make: "Honda", model: "Civic" },
  auditDate: new Date().toISOString(),
  findings: [{
    id: "f-1",
    severity: "warning" as const,
    category: "Missing Companion Service",
    title: "Consider Brake Fluid Flush",
    description: "Brake service may benefit from a fluid flush.",
    suggestedJobTitle: "Brake Fluid Flush",
    suggestedJobId: "brake-fluid-flush",
    confidence: 0.8,
  }],
  summary: { totalFindings: 1, critical: 0, warnings: 1, info: 0, score: 95 },
};

function installFetch(mode: "matched" | "no_match" | "thin" | "thin_unusable" | "preview_race") {
  const calls: FetchCall[] = [];
  const pendingPreview: Record<string, {
    resolve: (response: FetchResponse) => void;
    reject: (error: Error) => void;
  }> = {};
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.endsWith("/api/shop/features")) return json(200, { enabledFeatureIds: ["estimate_assist"] });
    if (url.endsWith("/api/estimate-assist/audit")) return json(200, { ok: true, report });
    if (url.endsWith("/api/estimate-assist/resolve-recommendation")) {
      if (mode === "preview_race") {
        const body = JSON.parse(String(calls.at(-1)?.init?.body || "{}"));
        if (body.mode === "preview") {
          const sourceId = String(body.selection?.source?.id || "");
          return new Promise<FetchResponse>((resolve, reject) => {
            pendingPreview[sourceId] = { resolve, reject };
          });
        }
        return json(200, {
          ok: true,
          resolution: {
            status: "candidates",
            warnings: [],
            candidates: [
              {
                id: "preview-a",
                title: "Brake Fluid Flush A",
                source: { kind: "canned", shopId: 42, id: "preview-a", sourceSystem: "protractor" },
                lines: [],
                warnings: [],
                relevance: { score: 70, band: "likely", serviceMatch: "exact", vehicleMatch: "unknown" },
              },
              {
                id: "preview-b",
                title: "Brake Fluid Flush B",
                source: { kind: "canned", shopId: 42, id: "preview-b", sourceSystem: "protractor" },
                lines: [],
                warnings: [],
                relevance: { score: 70, band: "likely", serviceMatch: "exact", vehicleMatch: "unknown" },
              },
            ],
          },
        });
      }
      if (mode === "thin" || mode === "thin_unusable") {
        const preview = JSON.parse(String(calls.at(-1)?.init?.body || "{}")).mode === "preview";
        const source = { kind: "canned", shopId: 42, id: "thin-1", sourceSystem: "protractor" };
        return preview
          ? json(200, {
              ok: true,
              resolution: {
                status: "candidates",
                warnings: mode === "thin_unusable"
                  ? [{ code: "missing_lines", message: "Selected detail has no usable lines." }]
                  : [],
                candidates: [{
                  id: "thin-1",
                  title: "Brake Fluid Flush",
                  source,
                  lines: mode === "thin_unusable"
                    ? []
                    : [{ lineType: "labor", description: "Flush brake system", quantity: 0.7, unitPrice: 100, extendedPrice: 70 }],
                  warnings: mode === "thin_unusable"
                    ? [{ code: "missing_lines", message: "Selected detail has no usable lines." }]
                    : [],
                  relevance: { score: 85, band: "strong", serviceMatch: "exact", vehicleMatch: "exact" },
                }],
              },
            })
          : json(200, {
              ok: true,
              resolution: {
                status: "candidates",
                warnings: [],
                candidates: [{
                  id: "thin-1",
                  title: "Brake Fluid Flush",
                  source,
                  lines: [],
                  warnings: [{ code: "missing_lines", message: "Select this job to load current details." }],
                  relevance: { score: 70, band: "likely", serviceMatch: "exact", vehicleMatch: "unknown" },
                }],
              },
            });
      }
      return mode === "matched"
        ? json(200, {
            ok: true,
            resolution: {
              status: "ambiguous",
              warnings: ["Historical pricing should be reviewed."],
              candidates: [
                {
                  id: "history-1",
                  title: "Brake Fluid Exchange",
                  source: { type: "historical", label: "Shop history" },
                  vehicleRelevance: "Same year/make/model",
                  total: 129,
                  lines: [
                    { lineType: "labor", description: "Brake fluid exchange labor", quantity: 0.8, unitPrice: 0, extendedPrice: 0 },
                    { lineType: "part", description: "DOT 4 brake fluid", quantity: 1, unitPrice: 19, extendedPrice: 19 },
                  ],
                },
              ],
            },
          })
        : json(200, {
            ok: true,
            resolution: {
              status: "no_match",
              warnings: ["No reusable canned or historical job was suitable."],
              candidates: [],
            },
          });
    }
    if (url.endsWith("/api/estimate-assist/job-builder")) {
      return json(200, {
        ok: true,
        estimate: {
          title: "Brake Fluid Flush",
          description: "Generated fallback package",
          laborHours: { recommended: 0.8, typical: 0.8, min: 0.5, max: 1.1 },
          requiredParts: ["DOT 4 brake fluid"],
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return {
    calls,
    pendingPreview,
    restore() { globalThis.fetch = originalFetch; },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(node => node.textContent?.includes(label));
  assert.ok(found, `expected button containing "${label}"`);
  return found as HTMLButtonElement;
}

function mount(): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(EstimateAssistPanel as React.ComponentType<any>, {
      initialWorkOrderId: "wo-1",
      initialRoDisplay: "1001",
    }));
  });
  return { container, root };
}

let failures = 0;
async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}`, error);
  }
}

async function main(): Promise<void> {
  console.log("Estimate Assist recommendation-review UI checks");

  await scenario("shows candidate source lines and requires explicit selection/confirmation", async () => {
    const mock = installFetch("matched");
    const { container, root } = mount();
    try {
      await settle();
      await settle();
      await act(async () => { button(container, "Review matches").click(); await settle(); });
      await settle();
      const text = container.textContent || "";
      assert.equal(text.includes("Brake Fluid Exchange"), true);
      assert.equal(text.includes("Shop history"), true);
      assert.equal(text.includes("DOT 4 brake fluid"), true);
      assert.equal(text.includes("Same year/make/model"), true);
      const confirm = button(container, "Confirm selected existing job");
      assert.equal(confirm.disabled, true, "selection must be required before confirmation");
      const radio = container.querySelector('input[type="radio"][value="history-1"]') as HTMLInputElement | null;
      assert.ok(radio, "candidate selection radio should be rendered");
      await act(async () => { radio.click(); await settle(); });
      assert.equal(confirm.disabled, false);
      await act(async () => { confirm.click(); await settle(); });
      assert.equal((container.textContent || "").includes("Selected source lines"), true);
      const resolverCall = mock.calls.find(call => String(call.input).endsWith("/api/estimate-assist/resolve-recommendation"));
      assert.ok(resolverCall, "resolver should be called");
      const resolverBody = JSON.parse(String(resolverCall.init?.body));
      assert.equal(resolverBody.vehicle.vin, report.vehicle.vin, "audited VIN must be sent to resolver");
    } finally {
      act(() => root.unmount());
      container.remove();
      mock.restore();
    }
  });

  await scenario("distinguishes no match and makes generated fallback explicit with VIN", async () => {
    const mock = installFetch("no_match");
    const { container, root } = mount();
    try {
      await settle();
      await settle();
      await act(async () => { button(container, "Review matches").click(); await settle(); });
      await settle();
      assert.equal((container.textContent || "").includes("No suitable match"), true);
      const fallback = button(container, "Use generated estimate fallback");
      await act(async () => { fallback.click(); await settle(); });
      await settle();
      assert.equal((container.textContent || "").includes("Generated estimate fallback"), true);
      const builderCall = mock.calls.find(call => String(call.input).endsWith("/api/estimate-assist/job-builder"));
      assert.ok(builderCall, "fallback should call generated builder only after explicit click");
      const builderBody = JSON.parse(String(builderCall.init?.body));
      assert.equal(builderBody.vin, report.vehicle.vin, "audited VIN must carry into fallback");
    } finally {
      act(() => root.unmount());
      container.remove();
      mock.restore();
    }
  });

  await scenario("hydrates a thin selected candidate before confirmation", async () => {
    const mock = installFetch("thin");
    const { container, root } = mount();
    try {
      await settle();
      await settle();
      await act(async () => { button(container, "Review matches").click(); await settle(); });
      await settle();
      const radio = container.querySelector('input[type="radio"][value="thin-1"]') as HTMLInputElement | null;
      assert.ok(radio, "thin candidate selection radio should be rendered");
      await act(async () => { radio.click(); await settle(); });
      await settle();
      const confirm = button(container, "Confirm selected existing job");
      assert.equal(confirm.disabled, false, "hydrated thin candidate should become confirmable");
      const previewCall = mock.calls.find(call => {
        if (!String(call.input).endsWith("/api/estimate-assist/resolve-recommendation")) return false;
        const body = JSON.parse(String(call.init?.body || "{}"));
        return body.mode === "preview";
      });
      assert.ok(previewCall, "thin candidate should request selected-detail preview");
      const previewBody = JSON.parse(String(previewCall?.init?.body));
      assert.equal(previewBody.selection.source.id, "thin-1");
      await act(async () => { confirm.click(); await settle(); });
      assert.equal((container.textContent || "").includes("Selected source lines"), true);
    } finally {
      act(() => root.unmount());
      container.remove();
      mock.restore();
    }
  });

  await scenario("offers generated fallback when selected detail remains unusable", async () => {
    const mock = installFetch("thin_unusable");
    const { container, root } = mount();
    try {
      await settle();
      await settle();
      await act(async () => { button(container, "Review matches").click(); await settle(); });
      await settle();
      const radio = container.querySelector('input[type="radio"][value="thin-1"]') as HTMLInputElement | null;
      assert.ok(radio, "thin candidate selection radio should be rendered");
      await act(async () => { radio.click(); await settle(); });
      await settle();
      assert.equal((container.textContent || "").includes("Use generated estimate fallback"), true);
      assert.equal(
        button(container, "Confirm selected existing job").disabled,
        true,
        "unusable selected detail must not be confirmable",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      mock.restore();
    }
  });

  await scenario("ignores a stale failed preview after a newer candidate is selected", async () => {
    const mock = installFetch("preview_race");
    const { container, root } = mount();
    try {
      await settle();
      await settle();
      await act(async () => { button(container, "Review matches").click(); await settle(); });
      await settle();
      const candidateA = container.querySelector('input[type="radio"][value="preview-a"]') as HTMLInputElement | null;
      const candidateB = container.querySelector('input[type="radio"][value="preview-b"]') as HTMLInputElement | null;
      assert.ok(candidateA && candidateB, "both preview candidates should be rendered");
      await act(async () => { candidateA.click(); await settle(); });
      await act(async () => { candidateB.click(); await settle(); });
      assert.ok(mock.pendingPreview["preview-a"], "slow candidate A preview should be pending");
      assert.ok(mock.pendingPreview["preview-b"], "candidate B preview should be pending");

      await act(async () => {
        mock.pendingPreview["preview-b"].resolve(json(200, {
          ok: true,
          resolution: {
            status: "candidates",
            warnings: [],
            candidates: [{
              id: "preview-b",
              title: "Brake Fluid Flush B hydrated",
              source: { kind: "canned", shopId: 42, id: "preview-b", sourceSystem: "protractor" },
              lines: [{ lineType: "labor", description: "B labor", quantity: 1, unitPrice: 100, extendedPrice: 100 }],
              warnings: [],
              relevance: { score: 85, band: "strong", serviceMatch: "exact", vehicleMatch: "exact" },
            }],
          },
        }));
        await settle();
      });
      await act(async () => {
        mock.pendingPreview["preview-a"].reject(new Error("slow A failed"));
        await settle();
      });

      const text = container.textContent || "";
      assert.equal(text.includes("Brake Fluid Flush B hydrated"), true);
      assert.equal(text.includes("slow A failed"), false, "stale A failure must not overwrite B state");
      assert.equal(
        button(container, "Confirm selected existing job").disabled,
        false,
        "newer selected candidate should remain confirmable",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      mock.restore();
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} Estimate Assist UI scenario(s) failed.`);
    process.exit(1);
  }
  console.log("\nEstimate Assist recommendation-review UI checks passed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
