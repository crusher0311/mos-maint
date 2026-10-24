import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { DEFAULT_LAYOUT, type DesignerLayout } from "@/lib/keytag-designer-types";
import { ExtraFieldsPanel } from "./ExtraFieldsPanel";
import { useKeytagPrintDetails } from "./useKeytagPrintDetails";

// Offline DOM fixture: no app boot, database, or network access.
async function main() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  Object.assign(globalThis, {
    React, window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const originalFetch = globalThis.fetch;
  const layout: DesignerLayout = {
    ...DEFAULT_LAYOUT,
    elements: [
      ...DEFAULT_LAYOUT.elements,
      ...(["vehicleColor", "licensePlate", "custom"] as const).map((type, index) => ({
        ...DEFAULT_LAYOUT.elements[0], id: type === "custom" ? "custom_test" : type,
        type, label: ["Color", "Plate", "Parking bay"][index], visible: true,
      })),
    ],
  };
  let requestCount = 0;
  globalThis.fetch = async (url) => {
    assert.equal(url, "/api/keytag/settings");
    requestCount++;
    return new Response(JSON.stringify({ config: { designerLayout: layout } }), { status: 200 });
  };
  const root = createRoot(document.getElementById("root")!);
  let api: ReturnType<typeof useKeytagPrintDetails>;
  function Fixture({ shop }: { shop: string }) {
    api = useKeytagPrintDetails(shop, () => {});
    return api.dialog;
  }
  try {
    await act(async () => root.render(<Fixture shop="12" />));
    let operation!: ReturnType<typeof api.begin>;
    let result!: Promise<Record<string, string> | null>;
    await act(async () => {
      operation = api.begin(null);
      result = api.collect(operation, { vehicle: { color: "Silver", licensePlate: "ABC 1234" } }, "Toyota Camry");
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelectorAll("input").length, 3);
    assert.equal((document.getElementById("keytag-vehicleColor") as HTMLInputElement).value, "Silver");
    assert.equal((document.getElementById("keytag-licensePlate") as HTMLInputElement).value, "ABC 1234");
    assert.equal((document.getElementById("keytag-custom_test") as HTMLInputElement).maxLength, 64);
    await act(async () => document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.deepEqual(await result, { vehicleColor: "Silver", licensePlate: "ABC 1234" });

    // A new vehicle cannot inherit prior input values.
    await act(async () => {
      operation = api.begin(null);
      result = api.collect(operation, {}, "Honda Accord");
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal((document.getElementById("keytag-vehicleColor") as HTMLInputElement).value, "");
    await act(async () => root.render(<Fixture shop="27" />));
    assert.equal(await result, null);
    assert.equal(operation.isCurrent(), false);
    assert.equal(operation.controller.signal.aborted, true);
    assert.equal(document.querySelector("form"), null);

    // Cancelling the details prompt closes only this operation's mobile placeholder.
    let closed = false;
    const placeholder = { closed: false, close: () => { closed = true; } } as Window;
    await act(async () => {
      operation = api.begin(placeholder);
      result = api.collect(operation, {}, "Ford Escape");
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(await result, null);
    assert.equal(closed, true);
    assert.equal(operation.isCurrent(), false);

    // No configured extras means the legacy flow proceeds without a details prompt.
    layout.elements = DEFAULT_LAYOUT.elements;
    await act(async () => {
      operation = api.begin(null);
      result = api.collect(operation, {}, "Toyota Camry");
    });
    assert.deepEqual(await result, {});
    assert.equal(document.querySelector("form"), null);
    layout.elements = [
      ...DEFAULT_LAYOUT.elements,
      ...(["vehicleColor", "licensePlate", "custom"] as const).map(type => ({
        ...DEFAULT_LAYOUT.elements[0], id: type === "custom" ? "custom_test" : type,
        type, visible: true,
      })),
    ];

    // Hidden definitions count against the custom-field limit.
    const full = { ...layout, elements: [...layout.elements, ...[1, 2].map(index => ({
      ...layout.elements[layout.elements.length - 1], id: `custom_hidden_${index}`, visible: false,
    }))] };
    await act(async () => root.render(<ExtraFieldsPanel layout={full} onAdd={() => assert.fail("Disabled add action fired")} />));
    const buttons = Array.from(document.querySelectorAll("button"));
    assert(buttons.every(button => button.disabled));
    assert.equal(requestCount, 4);
    console.log("Keytag frontend offline smoke checks passed: prefill, limits, reset, shop cancellation.");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
