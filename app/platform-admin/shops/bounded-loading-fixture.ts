// Offline contract fixture: no application server, API handlers, or database imports.
import http from "node:http";
import { build } from "esbuild";

export async function createBoundedFixture() {
  let shops = Array.from({ length: 123 }, (_, i) => ({
    _id: `offline-${i + 1}`, shopId: i + 1, name: `Offline Garage ${i + 1}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    integrations: ["Tekmetric"], billing: { plan: "trial", status: "trial", isPaid: false, vinViewCount: null },
    userCount: null, vehicleCount: null, summaryState: "loading",
    trial: { startedAt: null, endsAt: "2030-01-01T00:00:00Z", days: 14, daysLeft: 7, cardOnFile: false },
    cardOnFile: false, reviewStatus: "pending",
  }));
  const state = { pageDelay: 0, summaryDelay: 20, summaryGate: null as Promise<void> | null, fail: false, summaryFail: false,
    noFleet: false, requests: [] as string[], writes: [] as { path: string; body: any }[] };
  const bundle = await build({
    stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client";
      import Shops from "./app/platform-admin/shops/page"; createRoot(document.getElementById("root")).render(<Shops/>);`,
      resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife",
    plugins: [{ name: "offline-panel", setup(b) {
      b.onResolve({ filter: /^@\/components\/DataStatusPanel$/ }, () => ({ path: "panel", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export default function Panel(){return null}", loader: "tsx" }));
    } }],
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://offline.invalid");
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data));
    };
    if (url.pathname === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return;
    }
    if (url.pathname.startsWith("/api/")) {
      state.requests.push(url.pathname + url.search);
      if (req.method !== "GET") {
        let body = ""; for await (const chunk of req) body += chunk;
        const data = JSON.parse(body);
        state.writes.push({ path: url.pathname, body: data });
        if (data.action === "rename") shops = shops.map(s => String(s.shopId) === url.pathname.split("/").pop() ? { ...s, name: data.name } : s);
        json({ ok: true, approvedCount: data.shopIds?.length ?? 0,
          requestedCount: data.shopIds?.length ?? 0, succeeded: data.shopIds?.length ?? 0, failed: 0, results: [] }); return;
      }
      const view = url.searchParams.get("view");
      if (view === "page") {
        const search = (url.searchParams.get("search") || "").toLowerCase();
        const filtered = shops.filter(s => s.name.toLowerCase().includes(search)).slice().reverse();
        const page = Number(url.searchParams.get("page") || 1);
        const result = { ok: true, shops: filtered.slice((page - 1) * 50, page * 50),
          defaultTrialDays: 14, pagination: { page, pageSize: 50, total: filtered.length, totalPages: Math.ceil(filtered.length / 50) },
          fleet: state.noFleet ? null : { total: shops.length, activeOrTrial: 117, active: 83, trialing: 34, founder: 19, updatedAt: "2026-04-02T12:23:00Z" },
          bulkEligibleShops: filtered.map(({ shopId, name, trial, cardOnFile }) => ({ shopId, name, trial, cardOnFile })),
          bulkApprovePendingShops: filtered.map(({ shopId, name, reviewStatus }) => ({ shopId, name, reviewStatus })),
          activityUnavailable: state.noFleet };
        const fail = state.fail;
        await new Promise(r => setTimeout(r, state.pageDelay));
        json(fail ? { ok: false } : result, fail ? 503 : 200); return;
      }
      if (view === "summary") {
        const ids = (url.searchParams.get("shopIds") || "").split(",");
        const result = { ok: true, shops: shops.filter(s => ids.includes(String(s.shopId))).map(s => ({
          ...s, name: "STALE SUMMARY NAME", reviewStatus: "approved", userCount: 9, vehicleCount: 18,
          billing: { ...s.billing, plan: "STALE PLAN", vinViewCount: 27 }, summaryState: "ready",
        })) };
        const fail = state.summaryFail;
        await state.summaryGate;
        await new Promise(r => setTimeout(r, state.summaryDelay));
        json(fail ? { ok: false } : result, fail ? 503 : 200); return;
      }
      if (view === "history") {
        json({ ok: true, shops: [{ shopId: url.searchParams.get("shopId"), cardCaptureEmailHistory: [
          { sentAt: "2026-01-02T12:00:00Z", recipient: "owner@example.test", source: "admin", adminEmail: "admin@example.test", mode: "reminder", daysLeft: 7 },
        ] }] }); return;
      }
      json({ ok: false }, 404); return;
    }
    if (url.pathname !== "/") { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Offline bounded shops</title>
      <style>body{font:14px system-ui;margin:24px;color:#172033;background:#fafafa}
      table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left}
      button,input,select{padding:8px;margin:3px}svg{width:16px;height:16px;display:inline-block}img{width:24px;height:24px}
      .hidden{display:none}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  return { state, server };
}
