// Shared builder for the DESKTOP sticker print document (popup + iframe).
//
// Why this exists: oil-change stickers printed correctly at their true
// physical size on Windows (Chrome/Edge honor the popup's
// `@page { size: …; margin: 0 }` and print at real dimensions), but the same
// sticker came out ENLARGED on a Mac (Safari/Chrome). The root cause was the
// Quick Sticker popup sizing the page/image in *viewport* units
// (`100vw`/`100vh`) with `object-fit: fill`. On Windows the custom `@page`
// size is honored, so `100vw` == the label width (e.g. 2in) and it prints
// correctly. On macOS the small custom `@page` size is unreliable — the print
// pipeline falls back to the selected paper / printable area, so `100vw`
// balloons to the full sheet width and the sticker is scaled up past the
// label edge.
//
// The fix is to size the page, body and image in *physical inches* taken from
// the shop-configured sticker size. Even if macOS ignores the `@page` size,
// the image stays pinned at its true inch dimensions instead of stretching to
// the viewport, so Mac matches Windows. `object-fit: contain` guards against
// any residual stretching. Windows output is unchanged because there
// `100vw` already equalled the inch size.
//
// NOTE: this is the DESKTOP path only. Do NOT route mobile (iOS/Android)
// through here — iOS Safari/AirPrint ignore `@page { size }` entirely and need
// the real-PDF path in `lib/print-mobile.ts` + `lib/sticker-pdf.ts`.

import { getStickerSizeInches } from "./sticker-pdf";

export interface BuildStickerPrintHtmlOptions {
  // When true, embed a script that auto-calls window.print() once the image
  // has loaded. Use this for the popup-window path (Quick Sticker), where the
  // print is triggered from inside the new window. Leave false for the iframe
  // path (dashboard), where the parent page calls iframe.contentWindow.print()
  // itself — having both would double-fire the print dialog.
  autoPrint?: boolean;
}

export function buildStickerPrintHtml(
  dataUrl: string,
  size: string,
  opts: BuildStickerPrintHtmlOptions = {},
): string {
  const { width, height } = getStickerSizeInches(size);
  const w = `${width}in`;
  const h = `${height}in`;

  const autoPrintScript = opts.autoPrint
    ? `<script>
      (function () {
        var img = document.getElementById('printImg');
        if (!img) { return; }
        function go() { setTimeout(function () { window.focus(); window.print(); }, 100); }
        if (img.complete) { go(); }
        else {
          img.onload = go;
          img.onerror = function () {
            document.body.innerHTML = '<p>Failed to load image for printing.</p>';
          };
        }
      })();
    </script>`
    : "";

  // Physical-inch sizing (NOT viewport units) is the whole point — see the
  // file header. `object-fit: contain` keeps the rendered sticker at its true
  // size/aspect even if a platform tries to stretch the box.
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Print Sticker</title>
  <style>
    @page { size: ${w} ${h}; margin: 0 !important; }
    * { margin: 0 !important; padding: 0 !important; box-sizing: border-box !important; }
    html, body {
      width: ${w};
      height: ${h};
      overflow: hidden;
      background: #ffffff;
    }
    img#printImg {
      display: block;
      width: ${w};
      height: ${h};
      object-fit: contain;
    }
    @media print {
      @page { size: ${w} ${h}; margin: 0 !important; }
      html, body {
        width: ${w};
        height: ${h};
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      img#printImg {
        width: ${w};
        height: ${h};
      }
    }
  </style>
</head>
<body>
  <img id="printImg" src="${dataUrl}" />
  ${autoPrintScript}
</body>
</html>`;
}
