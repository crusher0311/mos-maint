// Classic script shared by provider adapters and the side panel.
// Nominal media sizes; raster pixels and driver borderless overscan are separate.
(function (root) {
  const sizes = Object.freeze({
    '1.5x2.25': [1.5, 2.25], '2x2': [2, 2], '2x2.5': [2, 2.5],
    '2x3': [2, 3], '2x3.5': [2, 3.5],
  });
  function buildHtml(sticker) {
    const dimensions = Object.hasOwn(sizes, sticker?.size) ? sizes[sticker.size] : null;
    if (!dimensions) throw new Error('Unsupported sticker size. Please generate the sticker again.');
    const [width, height] = dimensions;
    const src = String(sticker.dataUrl || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Print Sticker</title><style>
      @page { size: ${width}in ${height}in; margin: 0; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}in; height: ${height}in; background: white; }
      img { display: block; width: ${width}in; height: ${height}in; object-fit: contain;
        break-inside: avoid; }
      @media print { html, body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
    </style></head><body><img id="sticker" src="${src}"></body></html>`;
  }
  function whenReady(img, print, fail) {
    let settled = false;
    const ready = () => {
      if (settled) return;
      settled = true;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) print();
      else fail();
    };
    img.onload = ready;
    img.onerror = () => { if (!settled) { settled = true; fail(); } };
    if (img.complete) ready();
  }
  root.MosStickerPrintCore = Object.freeze({ buildHtml, whenReady, sizes });
})(globalThis);
