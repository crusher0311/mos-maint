/**
 * Offline-only preview of the real component. No Next server or API/auth imports.
 * Start: node --import tsx components/platform-admin/openai-usage-preview.ts
 * Loaded screenshot: http://127.0.0.1:8118/?loaded=1
 * Idle screenshot: http://127.0.0.1:8118/
 */
import http from "node:http";
import path from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

async function main() {
  const bundle = await build({
    stdin: {
      contents: `import React from "react"; import {createRoot} from "react-dom/client";
        import Panel from "./components/platform-admin/OpenAiUsagePanel";
        createRoot(document.getElementById("root")).render(React.createElement(Panel));
        if (new URLSearchParams(location.search).get("loaded") === "1") {
          const timer = setInterval(() => {
            const button = document.querySelector("#root button");
            if (button) { clearInterval(timer); button.click(); }
          }, 30);
        }`,
      loader: "tsx", resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const css = await postcss([tailwindcss()]).process(
    '@import "tailwindcss" source(none); @source "./OpenAiUsagePanel.tsx";',
    { from: path.resolve("components/platform-admin/openai-usage-preview.css") },
  );
  const known = {
    requests: 17, failedRequests: 1, promptTokens: 16342, completionTokens: 2873,
    cachedTokens: 4096, estimatedCostUsd: 0.02134,
    unpricedRequests: 0, unknownUsageRequests: 0, legacyRequests: 0,
  };
  const legacy = {
    requests: 3, failedRequests: 0, promptTokens: 2148, completionTokens: 387,
    cachedTokens: 0, estimatedCostUsd: 0,
    unpricedRequests: 3, unknownUsageRequests: 0, legacyRequests: 3,
  };
  const totals = {
    requests: 20, failedRequests: 1, promptTokens: 18490, completionTokens: 3260,
    cachedTokens: 4096, estimatedCostUsd: 0.02134,
    unpricedRequests: 3, unknownUsageRequests: 0, legacyRequests: 3,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://offline.test");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'");
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (url.pathname === "/bundle.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].text); return;
    }
    if (url.pathname === "/style.css") {
      res.writeHead(200, { "Content-Type": "text/css" }).end(`${css.css}
        body {margin:0;background:#f4f7fa;color:#111827;font-family:system-ui,sans-serif}
        main {max-width:1540px;margin:0 auto;padding:28px}
        .fixture-notice {margin:0 0 20px;font-size:13px;color:#64748b}
        @media(max-width:640px){main{padding:16px}}
      `); return;
    }
    if (url.pathname === "/api/platform-admin/openai-usage") {
      const days = Number(url.searchParams.get("days"));
      if (![1, 7, 30].includes(days)) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "Invalid fixture window" })); return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        ok: true, days, from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T00:00:00.000Z",
        totals, truncated: true,
        byFeature: [{ name: "/api/maintenance/analyze", ...known }, { name: "/api/legacy-analysis", ...legacy }],
        byModel: [{ name: "fixture-priced-model", ...known }, { name: "fixture-legacy-model", ...legacy }],
        byShop: [{ name: 381, ...known }, { name: null, ...legacy }],
        byDay: [{ name: "2026-01-17", ...known }, { name: "2026-01-18", ...legacy }],
      })); return;
    }
    if (url.pathname !== "/") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>OpenAI usage — offline fixture</title><link rel="stylesheet" href="/style.css"></head>
      <body><main><p class="fixture-notice">OFFLINE COMPONENT PREVIEW — synthetic test fixtures only. No live API, authentication, or database access.</p>
      <div id="root"></div></main><script src="/bundle.js"></script></body></html>`);
  });
  server.listen(8118, "0.0.0.0", () => console.log(`Offline OpenAI preview ready on port 8118; PID ${process.pid}`));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
