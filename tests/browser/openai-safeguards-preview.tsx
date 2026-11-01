/** Offline static preview of the real components. No auth bypass or live API. */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "node:http";
import OpenAiUsagePanel from "../../components/platform-admin/OpenAiUsagePanel";
import RecommendedClient from "../../app/dashboard/recommended/RecommendedClient";

// tsx's standalone classic JSX transform differs from Next's automatic runtime.
(globalThis as any).React = React;
createServer((req, res) => {
  if (req.url?.startsWith("/api/")) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end('{"ok":false,"error":"Offline visual fixture; no live APIs."}');
    return;
  }
  const html = renderToStaticMarkup(<main>
    <h1>Offline AI safeguards preview</h1>
    <p>Static rendering of the actual components. No provider or database connections.</p>
    <RecommendedClient initialVin="" initialModel="gpt-4o" />
    <OpenAiUsagePanel />
  </main>);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font:16px system-ui;margin:32px;background:#f8fafc;color:#172033}main{max-width:1100px;margin:auto}
    section,form{background:white;padding:20px;margin:20px 0;border:1px solid #ddd;border-radius:8px}
    input,select,button{font:inherit;padding:8px;margin:8px}svg{width:20px;height:20px}
    .sr-only{display:none}</style></head><body>${html}</body></html>`);
}).listen(3002, "0.0.0.0", () => console.log("Offline AI safeguards preview listening on 3002"));
