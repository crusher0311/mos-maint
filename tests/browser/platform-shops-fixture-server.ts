// Serves the real page and real GET handler with synthetic stores. Never boots Next.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { apiFixture } from "../helpers/platform-shops-fixture";

export async function createShopsFixture() {
  const api = await apiFixture();
  const state = { coreDelay: 0, summaryDelay: 1500, coreFail: false, summaryFail: false, coreRequests: 0,
    summaryGate: null as Promise<void> | null };
  const bundle = await build({
    entryPoints: ["tests/browser/platform-shops-fixture.tsx"], bundle: true, write: false,
    jsx: "automatic", platform: "browser", format: "iife",
    plugins: [{ name: "unrelated-detail", setup(b) {
      b.onResolve({ filter: /^@\/components\/DataStatusPanel$/ }, () => ({ path: "panel", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export default function Panel(){return null}", loader: "tsx" }));
    } }],
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://offline.invalid");
    if (url.pathname === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
    if (url.pathname === "/api/platform-admin/shops") {
      const view = url.searchParams.get("view") || "legacy";
      if (view === "core") state.coreRequests++;
      const response = await api.get(view, url.searchParams.get("shopId") || undefined);
      const text = await response.text();
      const fail = view === "core" ? state.coreFail : view === "summary" ? state.summaryFail : false;
      if (view === "summary" && state.summaryGate) await state.summaryGate;
      await new Promise(r => setTimeout(r, view === "core" ? state.coreDelay : view === "summary" ? state.summaryDelay : 0));
      res.writeHead(fail ? 503 : response.status, { "Content-Type": "application/json" });
      res.end(fail ? JSON.stringify({ error: "Synthetic unavailable" }) : text); return;
    }
    if (url.pathname.match(/^\/api\/platform-admin\/shops\/\d+$/) && req.method === "PATCH") {
      let body = ""; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      const id = url.pathname.split("/").pop();
      api.f.shops = api.f.shops.map(s => String(s.shopId) === id ? { ...s, name: data.name ?? s.name } : s);
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true })); return;
    }
    if (url.pathname !== "/") { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>All Shops — isolated fixture</title>
      <style>body{font:14px system-ui;color:#172033;margin:24px;background:#fafafa}table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left}button,input,select{padding:8px;margin:3px}svg{width:16px;height:16px;display:inline-block}img{width:24px;height:24px}h1{font-size:26px}[role=alert]{color:#a00}.hidden{display:none}</style>
      </head><body><p>Offline synthetic fleet — no live data or writes</p><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  return { server, state, api };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 8099);
  createShopsFixture().then(f => f.server.listen(port, "0.0.0.0", () => console.log(`Offline All Shops ready on ${port}`)));
}
