/**
 * TEST ONLY. Synthetic in-memory data; no routes, auth, database or provider imports.
 * Run with the repository deny-network-egress preload and loopback enabled.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import type { HistorySnapshot } from "../history-client";

export async function createHistoryPreviewFixture() {
  const [bundle, css] = await Promise.all([
    build({
      stdin: {
        contents: `import React from "react";
          import {createRoot} from "react-dom/client";
          import ProtractorHistoryClient from "./app/platform-admin/protractor-history/ProtractorHistoryClient";
          createRoot(document.getElementById("root")).render(<ProtractorHistoryClient />);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife",
      define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    }),
    readFile("app/globals.css", "utf8").then(source =>
      postcss([tailwind()]).process(source, { from: "app/globals.css" })),
  ]);
  const snapshot: HistorySnapshot = {
    config: {
      revision: "offline-fixture-revision",
      enabled: false,
      maxShopsPerTick: 2,
      horizonYears: 3,
      defaultTimezone: "America/Chicago",
      week: Array.from({ length: 7 }, (_, day) => ({
        day, open: "08:00", close: day === 6 ? "13:00" : "18:00", closed: day === 0,
      })),
      rolloutShopIds: [],
    },
    runtime: { active: false, shopId: null, lastOutcome: "complete" },
    shops: [
      { shopId: 101, name: "Cedar Auto — North", status: "waiting_off_hours", reason: "waiting_off_hours", paused: false, completed: false, lastError: null },
      { shopId: 102, name: "Juniper Motor Works", status: "blocked", reason: "missing_timezone", paused: false, completed: false, lastError: null },
      { shopId: 103, name: "Westlake Service Center", status: "paused", reason: "paused", paused: true, completed: false, lastError: null },
      { shopId: 104, name: "Parkside Automotive", status: "retry_backoff", reason: "retry_backoff", paused: false, completed: false, lastError: "Test-only synthetic timeout diagnostic" },
      { shopId: 105, name: "Alder Garage", status: "complete", reason: "complete", paused: false, completed: true, lastError: null },
      { shopId: 106, name: "Harbor Fleet Service", status: "blocked", reason: "transport_unavailable", paused: false, completed: false, lastError: null },
    ],
  };
  const requests: Array<{ method: string; path: string }> = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'");
    const json = (status: number, value: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (pathname === "/fixture.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].text);
    } else if (pathname === "/fixture.css") {
      res.writeHead(200, { "Content-Type": "text/css" }).end(css.css);
    } else if (pathname === "/favicon.ico") {
      res.writeHead(204).end();
    } else if (pathname === "/" || pathname === "/platform-admin/protractor-history") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html>
        <html lang="en" data-theme="light"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>TEST ONLY — Protractor history preview</title><link rel="stylesheet" href="/fixture.css">
        </head><body class="bg-gray-50 antialiased">
        <aside style="padding:10px 16px;background:#fef3c7;color:#78350f;font:12px system-ui;border-bottom:1px solid #fcd34d">
        OFFLINE TEST FIXTURE · Synthetic shop data only · No production auth, databases, or providers</aside>
        <div id="root"></div><script src="/fixture.js"></script></body></html>`);
    } else if (pathname === "/api/platform-admin/protractor-history") {
      requests.push({ method: req.method || "", path: pathname });
      if (req.method === "GET") { json(200, snapshot); return; }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (req.method === "PUT") {
          if (body.config?.revision !== snapshot.config.revision)
            return void json(409, { error: "Offline fixture revision conflict" });
          snapshot.config = { ...body.config, revision: `offline-${Date.now()}` };
          json(200, { config: snapshot.config });
        } else if (req.method === "POST") {
          const shop = snapshot.shops.find(item => item.shopId === body.shopId);
          if (!shop) return void json(400, { error: "Unknown fixture shop" });
          if (body.action === "pause" || body.action === "resume")
            shop.paused = body.action === "pause";
          shop.status = shop.reason = shop.paused ? "paused" : "queued";
          json(200, { ok: true, queued: body.action !== "pause" });
        } else json(405, { error: "Method not allowed" });
      } catch { json(400, { error: "Invalid fixture request" }); }
    } else {
      res.writeHead(404).end("Offline fixture: this destination is not served.");
    }
  });
  return { server, requests };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createHistoryPreviewFixture().then(({ server }) =>
    server.listen(5187, "127.0.0.1", () =>
      console.log("TEST ONLY history preview: http://127.0.0.1:5187/platform-admin/protractor-history")));
}
