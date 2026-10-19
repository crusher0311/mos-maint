import http from "node:http";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalHistoryImportsView } from "../../components/platform-admin/TerminalHistoryImports";
import { HISTORY_SUMMARY_LIMITS } from "../../lib/data/repositories/terminal-history-imports";

// Offline rendering only: no application bootstrap, database or provider imports.
const body = renderToStaticMarkup(<main>
  <h1>Sync Health — terminal history imports</h1>
  <p>Offline fixture. Read-only; no import authorization or replay.</p>
  <TerminalHistoryImportsView data={{
    limits: HISTORY_SUMMARY_LIMITS, campaignsTruncated: false, campaigns: [{
      campaignId: "example-history-campaign", status: "needs-attention",
      endedAt: "2026-10-18T06:00:00.000Z", recordedUnresolved: 5,
      outcomes: { imported: 120, verifiedPresent: 34, ambiguous: 2, indexReview: 1, thin: 1, unknown: 0 },
      receiptsSampled: 158, receiptsTruncated: false, shopsTruncated: false,
      shops: [{ shopId: 123, recordedUnresolved: 5, heldDays: ["2026-10-16"], heldDaysTruncated: false }],
    }],
  }} />
</main>);
http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><style>
    body{font:16px system-ui;color:#1f2937;background:#f8fafc;margin:32px}
    main{max-width:1100px;margin:auto} article{background:white;border:1px solid #ddd;border-radius:8px;padding:20px}
    p{line-height:1.6} h1{font-size:24px} h3{font-size:18px}
  </style></head><body>${body}</body></html>`);
}).listen(5000, "0.0.0.0", () => console.log("Offline history summary fixture ready on 5000"));
