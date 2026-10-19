// Offline only: bundles the real client component, never boots Next or auth/DB code.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { TerminalHistorySummary } from "../../lib/data/repositories/terminal-history-imports";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createHistoryFixture().then(server => server.listen(5000, "0.0.0.0",
    () => console.log("Offline history summary fixture ready on 5000")));
}

export function summary(imported = 120): TerminalHistorySummary {
  return {
    limits: { campaigns: 5, shops: 200, receipts: 2000, queryMs: 1500 },
    campaignsTruncated: false, nextCampaignCursor: null, campaigns: [{
      campaignId: "example-history-campaign", status: "needs-attention",
      endedAt: "2026-10-18T06:00:00.000Z", recordedUnresolved: 5,
      outcomes: { imported, verifiedPresent: 34, ambiguous: 2, indexReview: 1, thin: 1, unknown: 0 },
      receiptsSampled: imported + 38, receiptsTruncated: false, shopsTruncated: false,
      shopAfter: undefined, receiptAfter: undefined, nextShopCursor: null, nextReceiptCursor: null,
      shops: [{ shopId: 123, recordedUnresolved: 5, heldDays: ["2026-10-16"], heldDaysTruncated: false }],
    }],
  };
}

export async function createHistoryFixture(onSummary?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const bundle = await build({
    entryPoints: ["tests/browser/terminal-history-fixture.tsx"],
    bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife",
  });
  let refresh = 0;
  return http.createServer((req, res) => {
    const url = new URL(req.url!, "http://offline.invalid");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (url.pathname === "/api/platform-admin/terminal-history-imports") {
      if (onSummary) { onSummary(req, res); return; }
      const mode = /historyScenario=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        if (mode === "unauthorized" || mode === "unavailable") {
          res.writeHead(mode === "unauthorized" ? 401 : 503).end(JSON.stringify({ error: mode }));
        } else {
          const data = summary(120 + refresh++);
          if (mode === "pagination") {
            const c = data.campaigns[0];
            data.campaignsTruncated = !url.searchParams.has("campaignAfter");
            data.nextCampaignCursor = data.campaignsTruncated ? "fixture-older" : null;
            if (url.searchParams.has("campaignAfter")) c.campaignId = "older-history-campaign";
            else c.campaignId = url.searchParams.get("campaignId") ?? c.campaignId;
            c.shopAfter = url.searchParams.get("shopAfter") ?? undefined;
            c.receiptAfter = url.searchParams.get("receiptAfter") ?? undefined;
            c.shopsTruncated = !c.shopAfter;
            c.receiptsTruncated = !c.receiptAfter;
            c.nextShopCursor = c.shopsTruncated ? "fixture-shops" : null;
            c.nextReceiptCursor = c.receiptsTruncated ? "fixture-receipts" : null;
            if (c.shopAfter) c.shops[0].shopId = 456;
          }
          res.end(JSON.stringify(mode === "empty" ? { ...data, campaigns: [] } : data));
        }
      }, 500);
      return;
    }
    if (req.url === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].text); return;
    }
    if (req.url !== "/") { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Offline history summary</title>
      <style>body{font:16px system-ui;color:#1f2937;background:#f8fafc;margin:32px}
      main{max-width:1100px;margin:auto}section,article{background:white;border:1px solid #ddd;border-radius:8px;padding:20px}
      p{line-height:1.6}button,select{padding:10px}button:disabled{opacity:.5}[role=alert]{color:#991b1b}</style>
      </head><body><main><h1>Sync Health — terminal history imports</h1>
      <p>Offline fixture. Synthetic responses only; no production authentication, database, or import execution.</p>
      <label>Next response <select onchange="document.cookie='historyScenario='+this.value+'; SameSite=Strict; Path=/'">
      <option value="success">Success (counts change each refresh)</option><option value="unauthorized">Unauthorized (401)</option>
      <option value="unavailable">Unavailable (503)</option><option value="empty">Empty success</option>
      <option value="pagination">Paginated campaigns, shops and receipts</option></select></label>
      <div id="root"></div></main><script src="/fixture.js"></script></body></html>`);
  });
}
