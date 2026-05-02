// Shared helpers for the mobile-friendly print path. iOS Safari / AirPrint
// ignore CSS `@page { size }` and default to letter, which made fixed-size
// labels (oil change stickers, key tags, …) print as a tiny image on an
// 8.5"x11" sheet. The fix used by Quick Sticker (Task #219) is to ask the
// backend for a real PDF whose page size matches the label, then open that
// PDF in a new tab so AirPrint picks up the embedded page size.
//
// This module centralizes the two pieces every mobile print site needs:
//   1. UA-based mobile detection (including iPadOS-as-Macintosh).
//   2. Synchronously opening a placeholder tab off the user's tap, then
//      navigating it to the eventual blob URL once the PDF arrives.
// iOS Safari blocks `window.open` once a microtask boundary has passed
// since the gesture, so the open MUST happen before any `await` — that's
// why this is a synchronous helper that hands back a window handle.

export function isMobilePrintBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod|Android/i.test(ua)) return true;
  // iPadOS 13+ reports as Macintosh; distinguish by touch support.
  if (
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1
  ) {
    return true;
  }
  return false;
}

// Open a placeholder "Preparing…" tab synchronously. Returns the window
// handle (or null if popup-blocked) so the caller can navigate it to the
// PDF blob URL once the request comes back. Safe to call even if not on
// mobile — caller decides when to use it.
export function openMobilePlaceholderWindow(label: string = "label"): Window | null {
  let win: Window | null = null;
  try {
    win = window.open("", "_blank");
  } catch {
    return null;
  }
  if (!win) return null;
  try {
    win.document.open();
    win.document.write(
      '<!doctype html><html><head><meta charset="utf-8" /><title>Preparing ' +
        escapeHtml(label) +
        "…</title>" +
        '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
        "<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;color:#374151}</style>" +
        "</head><body>Preparing " +
        escapeHtml(label) +
        " for printing…</body></html>",
    );
    win.document.close();
  } catch {
    // Some browsers throw on document.write into a same-origin blank tab
    // during navigation — non-fatal, the location swap below still works.
  }
  return win;
}

// Navigate the placeholder window (or current tab as a fallback) to a PDF
// blob URL. Revokes the URL after a generous delay so iOS Safari has time
// to finish the navigation.
export function navigateWindowToPdfBlob(
  placeholder: Window | null,
  pdfBlob: Blob,
): void {
  const pdfUrl = URL.createObjectURL(pdfBlob);
  if (placeholder && !placeholder.closed) {
    placeholder.location.href = pdfUrl;
  } else {
    // Popup was blocked (or never opened) — navigate the current tab.
    // AirPrint still picks up the PDF page size.
    window.location.href = pdfUrl;
  }
  // 60s is plenty even on a slow connection; revoking sooner can break
  // the navigation in iOS Safari.
  setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}
