import http from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

async function main() {
  const result = await build({ entryPoints: ["tests/browser/saved-ipp-fixture.tsx"], bundle: true,
    write: false, jsx: "automatic", platform: "browser", plugins: [{ name: "offline-next-link", setup(b) {
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'import React from "react"; export default function Link(p){return React.createElement("a",p)}', loader: "js", resolveDir: process.cwd() }));
    } }] });
  const css = (await postcss([tailwindcss()]).process('@import "tailwindcss" source(none); @source "../../components/printing";',
    { from: "tests/browser/saved-ipp.css" })).css;
  const defaults: Record<string, string | null> = { sticker: "front", keytag: null };
  http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const kind = body.kind ?? url.searchParams.get("kind") ?? "sticker";
      if (req.method === "PUT") defaults[kind] = body.destinationId;
      if (url.pathname === "/api/print/destinations") {
        res.end(JSON.stringify({ shopId: 999, kind, canManage: true, defaultDestinationId: defaults[kind],
          destinations: kind === "sticker" ? ["front", "back"].map(id => ({ id, agentId: "offline-agent",
            printerId: id, kind, name: id === "front" ? "Front counter" : "Back counter", model: "ZINK hAppy",
            stock: { width: 5080, height: 6350 }, revision: "fixture", online: true, supported: true })) : [] }));
      } else if (url.pathname === "/api/print/status") res.end(JSON.stringify({ jobId: "fixture-job", destinationId: "front", status: "unknown" }));
      else res.end(JSON.stringify({ success: true, jobId: "fixture-job", status: "queued" }));
      return;
    }
    if (url.pathname === "/app.js") { res.setHeader("Content-Type", "application/javascript"); res.end(result.outputFiles[0].text); }
    else { res.setHeader("Content-Type", "text/html"); res.end(`<html><head><title>Offline Saved IPP checks</title><style>${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`); }
  }).listen(8080, "0.0.0.0", () => console.log("Offline Saved IPP fixture ready on 8080"));
}
main();
