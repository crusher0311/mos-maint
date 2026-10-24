import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Setting from "../../components/stickers/StickerQrAppearanceSetting";
import { useStickerQrAppearance, type StickerQrPreferences } from "../../components/stickers/useStickerQrAppearance";
import "../../generated-artifacts/sticker-qr-fixture.css";

// Browser fixture intercepts only its own QR endpoints; no real app or store.
let media = false;
const image = new URL("../../generated-artifacts/sticker-qr.png", import.meta.url).href;
const network = window.fetch.bind(window);
window.fetch = async (input, options) => {
  const url = String(input);
  if (url.startsWith("/api/sticker/custom-qr")) {
    media = options?.method !== "DELETE";
    return Response.json({ success: true });
  }
  if (url.startsWith("/api/sticker/qr-cache")) {
    if (url.includes("source=custom") && !media) return Response.json({ error: "Custom QR unavailable" }, { status: 409 });
    return network(image);
  }
  throw Error("Fixture blocked unexpected network request");
};
function App() {
  const [prefs, setPrefs] = useState<StickerQrPreferences>({ qrSource: "generated", qrBackgroundMode: "white" });
  const [available, setAvailable] = useState(false);
  const [background, setBackground] = useState("#fffaf0");
  const [included, setIncluded] = useState(true);
  const qr = useStickerQrAppearance({ ...prefs, background, included, ready: true, customQrAvailable: available, onCustomQrAvailableChange: setAvailable });
  return <main className="max-w-5xl mx-auto p-6 space-y-4">
    <h1 className="text-2xl font-semibold">Sticker QR settings — offline fixture</h1>
    <p>Real appearance controls and upload/preview state. Synthetic media; no live stores.</p>
    <label>Sticker background <input aria-label="Sticker background" type="color" value={background} onChange={e => setBackground(e.target.value)} /></label>
    <label className="block"><input type="checkbox" checked={included} onChange={e => setIncluded(e.target.checked)} /> Show QR code</label>
    <Setting {...prefs} onChange={setPrefs} background={background} included={included} customQrAvailable={available} qr={qr} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
