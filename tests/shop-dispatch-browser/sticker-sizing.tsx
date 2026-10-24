import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import { StickerDesigner } from "../../components/sticker-designer/StickerDesigner";
import { createDefaultLayout } from "../../lib/sticker-designer-types";

function Fixture() {
  const [qr, setQr] = useState("");
  const [version, setVersion] = useState(10);
  const [show, setShow] = useState(true);
  useEffect(() => {
    let current = true;
    QRCode.toDataURL("https://example.com", { version, scale: 8, margin: 4 })
      .then(url => { if (current) setQr(url); });
    return () => { current = false; };
  }, [version]);
  const layout = createDefaultLayout("2x2");
  layout.elements = layout.elements.map(el => el.type === "qrCode"
    ? { ...el, x: 10, y: 60, width: 80, height: 80 } : el);
  return <main style={{ fontFamily: "Arial", padding: 24 }}>
    <h1>Sticker QR sizing — offline fixture</h1>
    <button onClick={() => setVersion(version === 10 ? 2 : 10)}>Toggle density</button>
    <button onClick={() => setShow(!show)}>Toggle QR visibility</button>
    <StickerDesigner initialLayout={layout} initialSize="2x2" qrUrl={qr} showQRCode={show} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
