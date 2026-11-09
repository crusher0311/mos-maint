// Offline-only UI fixture. Never imports auth, database, or provider clients.
import http from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { fleetHistoryDefaults, validateFleetHistoryConfig } from "../../lib/integrations/protractor/fleet-history-policy";
import { resolveHistorySchedule } from "../../lib/integrations/protractor/history-schedule";

export async function historyAdminFixture() {
  const bundle = await build({
    stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client";
      import Page from "./app/platform-admin/protractor-history/ProtractorHistoryClient";
      createRoot(document.getElementById("root")).render(<Page />);`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, jsx: "automatic", platform: "browser",
    plugins: [{ name: "fixture-link", setup(b) {
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'import React from "react";export default function Link(p){return React.createElement("a",p)}', loader: "js", resolveDir: process.cwd(),
      }));
    } }],
  });
  const css = (await postcss([tailwindcss()]).process(
    '@import "tailwindcss" source(none); @source "../../app/platform-admin/protractor-history";',
    { from: "tests/browser/history-admin-fixture.css" })).css;
  let config = { ...fleetHistoryDefaults(), revision: "fixture-1", rolloutShopIds: [635] };
  let revision = 1;
  const calls: { method: string; body: any }[] = [];
  const shop = { shopId: 635, protractor: { locations: [{ TimeZone: "Central Standard Time", Address: { Country: "US" } }] } };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/api/platform-admin/protractor-history") {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        res.end(JSON.stringify({
          config, runtime: { active: false, shopId: null, lastOutcome: null,
            worker: { status: "not_reported", ready: false, lastSeenAt: null, revision: null } },
          shops: [{ shopId: 635, name: "Fictional South Kansas City Shop", status: "disabled", reason: "disabled",
            paused: false, completed: false, lastError: null, schedule: resolveHistorySchedule(config, shop),
            nextEligibleAt: null, progress: { oldestCursorAt: null, lastAttemptAt: null } }],
        })); return;
      }
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); calls.push({ method: req.method!, body });
      if (req.method === "PUT" && !body.config.enabled && body.confirmedHours && body.config.revision === config.revision) {
        config = { ...validateFleetHistoryConfig(body.config), revision: `fixture-${++revision}` };
        res.end(JSON.stringify({ config })); return;
      }
      res.writeHead(409).end(JSON.stringify({ error: "Fixture activation is blocked" })); return;
    }
    if (req.url !== "/") { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
      body{font-family:Arial,sans-serif;background:#f8fafc}</style></head><body>
      <p style="padding:12px;background:#fff4ce">Offline preview — fictional data, no production connections.</p>
      <div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  return { server, calls, config: () => config };
}
if (process.argv[1]?.endsWith("protractor-history-admin-fixture-server.ts"))
  historyAdminFixture().then(f => f.server.listen(3003, "0.0.0.0", () => console.log("Offline history admin fixture on 3003")));
