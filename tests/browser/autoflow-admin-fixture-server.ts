/**
 * Offline browser fixture for AutoFlow admin controls.
 *
 * This deliberately bundles the real page components but supplies only
 * sanitized, in-memory API responses. It must never be pointed at a MOS
 * deployment: its purpose is deterministic browser verification without
 * touching the development database.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.AUTOFLOW_FIXTURE_PORT || 5100);

type Mapping = { active: string[]; closed: string[]; excluded: string[] };
const state = {
  attached: false,
  mapping: {
    active: ["Saved Active"],
    closed: ["Close"],
    excluded: ["Appointment"],
  } satisfies Mapping,
};

const shops = [
  {
    shopId: 432,
    name: "Grand Rapids",
    autoflowDomain: "grand-rapids.autotext.me",
    canonicalIdentifiers: ["grand-rapids"],
    shopNumbers: [] as string[],
  },
  {
    shopId: 901,
    name: "Lansing",
    autoflowDomain: "lansing.autotext.me",
    canonicalIdentifiers: ["lansing"],
    shopNumbers: [] as string[],
  },
  { shopId: 902, name: "Unavailable fixture shop", autoflowDomain: "unavailable.autotext.me", canonicalIdentifiers: [], shopNumbers: [] as string[] },
];

const observedByShop: Record<number, Array<{ label: string; count: number; lastSeenAt: string }>> = {
  432: [
    { label: "CHECKED IN", count: 7, lastSeenAt: "2026-02-28T10:00:00.000Z" },
    { label: "Close", count: 3, lastSeenAt: "2026-02-27T10:00:00.000Z" },
    { label: "Appointment", count: 2, lastSeenAt: "2026-02-26T10:00:00.000Z" },
    { label: "Needs Review", count: 1, lastSeenAt: "2026-02-25T10:00:00.000Z" },
  ],
  901: [
    { label: "Lansing Active", count: 1, lastSeenAt: "2026-02-20T10:00:00.000Z" },
  ],
};

function json(res: http.ServerResponse, body: unknown, status = 200) {
  const output = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(output);
}

async function buildBundle() {
  const entry = path.join(root, "tests/browser/autoflow-admin-fixture-entry.tsx");
  const result = await esbuild.build({
    entryPoints: [entry],
    absWorkingDir: root,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    minify: false,
    write: false,
    sourcemap: "inline",
    alias: { "@": root },
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}

async function main() {
const bundle = await buildBundle();
const css = (await postcss([tailwindcss({ base: root })]).process(
  '@import "tailwindcss" source(none); @source "../../app/platform-admin/autoflow-numbers";',
  { from: path.join(root, "tests/browser/fixture.css") },
)).css;
const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoFlow admin fixture</title>
<style>
${css}
body{margin:0;background:#f8fafc;color:#172033;font:14px system-ui,-apple-system,sans-serif}
button,select,input{font:inherit} button{cursor:pointer}
table{border-collapse:collapse} th,td{vertical-align:top}
.max-w-5xl{max-width:64rem}.mx-auto{margin-left:auto;margin-right:auto}
.p-6{padding:1.5rem}.mb-8{margin-bottom:2rem}.mb-6{margin-bottom:1.5rem}
</style></head><body><main id="root"></main><script src="/bundle.js"></script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/__fixture__/reset" && req.method === "POST") {
    state.attached = false;
    shops[0].shopNumbers = [];
    state.mapping = { active: ["Saved Active"], closed: ["Close"], excluded: ["Appointment"] };
    return json(res, { ok: true });
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  if (url.pathname === "/bundle.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    return res.end(bundle);
  }
  if (url.pathname === "/api/platform-admin/autoflow-numbers" && req.method === "GET") {
    return json(res, {
      ok: true,
      unresolved: [],
      shops,
      conflicts: [],
    });
  }
  if (url.pathname === "/api/platform-admin/autoflow-numbers" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (body.number !== "615" || String(body.shopId) !== "432") {
      return json(res, { error: "fixture expected AutoFlow 615 → MOS 432" }, 400);
    }
    state.attached = true;
    shops[0].shopNumbers = ["615"];
    return json(res, { ok: true, number: "615", shop: { shopId: 432, name: "Grand Rapids" } });
  }
  if (url.pathname === "/api/platform-admin/autoflow-workflows" && req.method === "GET") {
    const selected = url.searchParams.get("shopId");
    if (!selected) return json(res, { ok: true, shops });
    const shopId = Number(selected);
    if (shopId === 902) return json(res, { error: "Fixture detail load failed" }, 503);
    // A deliberately delayed 432 response exercises stale detail protection.
    if (shopId === 432) await new Promise((resolve) => setTimeout(resolve, 500));
    if (!shops.some((shop) => shop.shopId === shopId)) return json(res, { error: "not found" }, 404);
    return json(res, {
      ok: true,
      shop: { shopId, name: shops.find((shop) => shop.shopId === shopId)?.name },
      mapping: shopId === 432 ? state.mapping : null,
      observed: observedByShop[shopId] || [],
      bounds: { lookbackDays: 90, maxEvents: 5000, maxLabels: 100 },
    });
  }
  if (url.pathname === "/api/platform-admin/autoflow-workflows" && req.method === "PUT") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    state.mapping = body.mapping;
    return json(res, { ok: true, shopId: body.shopId, mapping: state.mapping });
  }
  if (url.pathname === "/api/platform-admin/autoflow-workflows" && req.method === "DELETE") {
    state.mapping = { active: [], closed: [], excluded: [] };
    return json(res, { ok: true, mapping: null });
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`AutoFlow offline browser fixture listening on http://127.0.0.1:${port}`);
});
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});