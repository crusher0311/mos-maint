import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { KeytagDesigner } from "../../components/keytag-designer/KeytagDesigner";
import { DEFAULT_LAYOUT, type DesignerLayout } from "../../lib/keytag-designer-types";
import { keytagSampleExtras } from "../../lib/keytag-extra-fields";
import { useKeytagPrintDetails } from "../../components/keytag-designer/useKeytagPrintDetails";

const initial: DesignerLayout = { ...DEFAULT_LAYOUT, elements: [
  { ...DEFAULT_LAYOUT.elements[0], width: 330, x: 10, y: 5, height: 22 },
  ...(["vehicleColor", "licensePlate", "custom"] as const).map((type, index) => ({
    ...DEFAULT_LAYOUT.elements[1], id: type === "custom" ? "custom_fixture" : type, type,
    label: ["Color", "Plate", "Parking"][index], x: 10, y: 30 + index * 25,
    width: 330, height: 22, showLabel: true,
  })),
] };
function App() {
  const [layout, setLayout] = useState(initial);
  const [output, setOutput] = useState("");
  const details = useKeytagPrintDetails("offline-shop", () => {});
  window.fetch = async (url, options) => {
    if (url === "/api/keytag/settings") return new Response(JSON.stringify({ config: { designerLayout: layout } }));
    return nativeFetch(url, options);
  };
  async function render(next: DesignerLayout, extraValues = keytagSampleExtras(next)) {
    const response = await nativeFetch("/render", { method: "POST", body: JSON.stringify({ layout: next, extraValues }) });
    if (!response.ok) throw new Error("Fixture render failed");
    setOutput(URL.createObjectURL(await response.blob()));
  }
  return <main className="p-4 text-gray-900">
    <h1 className="text-xl font-bold">Offline keytag verification</h1>
    <p className="mb-4">Synthetic shop only. No database, provider calls, or physical printer.</p>
    <div style={{ height: 580 }}><KeytagDesigner initialLayout={initial}
      onSave={async next => { setLayout(next); await render(next); }}
      onDownload={async next => render(next)} /></div>
    <div className="flex items-center gap-4 mt-4">
      <button className="border rounded px-4 py-2" onClick={async () => {
        const operation = details.begin(null);
        const values = await details.collect(operation, { vehicle: { color: "Silver", licensePlate: "ABC 1234" } }, "2024 Test Vehicle");
        if (values) await render(layout, values);
      }}>Print details</button>
      <button className="border rounded px-4 py-2" onClick={() => render(layout)}>Render sample PNG</button>
      {output && <img alt="Actual PNG output" src={output} style={{ width: 525, height: 169 }} />}
    </div>
    {details.dialog}
  </main>;
}
const nativeFetch = window.fetch.bind(window);
createRoot(document.getElementById("root")!).render(<App />);
