import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { StickerDesigner } from "./StickerDesigner";
import { createDefaultLayout, type StickerLayout } from "@/lib/sticker-designer-types";

// Synthetic data only. This fixture has no app shell, API, auth, or shared store.
function Fixture() {
  const [layout, setLayout] = useState<StickerLayout>(() => {
    const layout = createDefaultLayout("2x2");
    layout.elements.find(e => e.type === "serviceLabel")!.content = "Legacy override";
    return layout;
  });
  const [serviceLabel, setServiceLabel] = useState("Next Service Due");
  return (
    <main className="max-w-5xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Oil-service label editor</h1>
      <p className="text-sm text-gray-600">Isolated browser fixture. Synthetic shop data; no live services.</p>
      <label>Service Label<input aria-label="Service Label" value={serviceLabel} onChange={e => setServiceLabel(e.target.value)} /></label>
      <StickerDesigner
        initialLayout={layout}
        initialSize="2x2"
        contentData={{ phone: "(503) 555-0186", tagline: "Cedar Street Auto", serviceLabel, serviceDate: "Jul 16, 2026", serviceMileage: "86,240 mi" }}
        onChange={(next) => setLayout(next)}
      />
      <output data-testid="layout-state" className="hidden">{JSON.stringify(layout)}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
