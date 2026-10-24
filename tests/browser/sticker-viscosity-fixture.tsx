import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { StickerDesigner } from "../../components/sticker-designer/StickerDesigner";
import { OilViscosityInput } from "../../components/stickers/OilViscosityInput";
import QuickStickerModal from "../../components/stickers/QuickStickerModal";
function Fixture() {
  const [oil, setOil] = useState("5W-30");
  const [quick, setQuick] = useState(false);
  const [layout, setLayout] = useState("");
  return <main style={{ padding: 24, maxWidth: 900 }}>
    <h1>Oil viscosity — offline production components</h1>
    <OilViscosityInput value={oil} onChange={setOil} />
    <button onClick={() => setQuick(true)}>Open Quick Sticker</button>
    <StickerDesigner contentData={{ oilViscosity: oil }} onChange={value => setLayout(JSON.stringify(value))} />
    <output data-testid="layout" hidden>{layout}</output>
    <QuickStickerModal isOpen={quick} onClose={() => setQuick(false)} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
