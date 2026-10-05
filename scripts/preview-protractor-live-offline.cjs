// Isolated visual smoke harness. Never imports server code or contacts a database.
// Run: node scripts/preview-protractor-live-offline.cjs
const http = require("node:http");
const esbuild = require("esbuild");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");

async function main() {
  const files = [
    "app/platform-admin/protractor-operator-stop/ProtractorOperatorStopClient.tsx",
    "components/platform-admin/ProtractorLiveMonitor.tsx",
  ];
  const bundle = await esbuild.build({
    stdin: {
      contents: `import React from "react"; import {createRoot} from "react-dom/client";
        import Controls from "./${files[0]}";
        import Monitor from "./${files[1]}";
        createRoot(document.getElementById("root")).render(<main className="mx-auto max-w-6xl space-y-6 p-6"><p className="font-semibold">Offline test fixture — no production access</p><Controls/><Monitor/></main>);`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const css = await postcss([tailwind()]).process(
    '@import "tailwindcss" source(none);' + files.map((file) => `@source "./${file}";`).join(""),
    { from: `${process.cwd()}/offline-preview.css` },
  );
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Offline preview does not allow mutations" }));
    }
    if (req.url === "/bundle.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end(bundle.outputFiles[0].text);
    }
    if (req.url === "/style.css") {
      res.writeHead(200, { "Content-Type": "text/css" });
      return res.end(css.css);
    }
    if (req.url === "/api/platform-admin/protractor-operator-stop") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true, trialReady: true, liveReady: true,
        state: { active: true, stopId: "offline-test-only", canary: null, canaryHistory: [] },
      }));
    }
    if (req.url === "/api/platform-admin/protractor-live-monitor") {
      const queue = { pendingSampled: 0, actionableSampled: 0, attemptsAtLeast3Sampled: 0, oldestActionableAgeMs: null };
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
          generatedAt: new Date().toISOString(),
          scope: { environment: "production", apiUsageCanonical: "mongo", callbackCanonical: "mongo", note: "Offline fixture, not production measurements." },
          relay: {
            status: "empty", sampleLimit: 50, sampled: 0, newestAt: null, latencySampled: 0,
            averageLatencyMs: null, p95LatencyMs: null, outcomes: {},
            durationScope: "client_attempt_including_local_admission_wait",
            note: "No real provider requests are made by this preview.",
          },
          callbacks: {
            status: "empty", sampleLimit: 400, sampled: 0, activationCohortStatus: "not_live",
            liveActivation: null, heldBacklog: queue, retainedContactsSampled: 0, lastProgressAt: null,
            outcomes: { status: "sampled", sampleLimit: 200, sampled: 0, liveActivation: null, heldBacklog: {}, note: "Offline fixture." },
            note: "No callback drain is run by this preview.",
          },
          breaker: {
            status: "empty", state: "unknown", openUntil: null, probeUntil: null, updatedAt: null,
            alerting: { transitionWiring: "present", deliveryStatus: "not-observable", note: "No alert delivery is attempted." },
          },
      }));
    }
    if (req.url.startsWith("/api/")) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Offline fixture: telemetry intentionally unavailable" }));
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  server.listen(5100, "127.0.0.1", () => console.log("Offline Protractor UI preview listening on 5100"));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });