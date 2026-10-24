// Only local static assets and the pure renderer. Never import app startup/auth/stores.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { renderKeytagDesigner } from "../../lib/canvas-renderer";
import { resolvePaperSize } from "../../lib/keytag-paper-sizes";
import { keytagExtraLayoutError } from "../../lib/keytag-extra-fields";
import { SAMPLE_DATA } from "../../lib/keytag-designer-types";

async function main() {
  const bundle = await build({ entryPoints: ["tests/browser/keytag-extra-fixture.tsx"], bundle: true,
    write: false, jsx: "automatic", platform: "browser", format: "iife" });
  const css = await postcss([tailwind()]).process(await readFile("tests/browser/keytag-extra-fixture.css", "utf8"),
    { from: "tests/browser/keytag-extra-fixture.css" });
  http.createServer(async (req, res) => {
    try {
      if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
      if (req.url === "/fixture.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      if (/^\/font\/Inter-18pt-(Regular|Bold)\.ttf$/.test(req.url || "")) {
        res.end(await readFile(`assets/fonts/${req.url!.split("/").pop()}`)); return;
      }
      if (req.url === "/render" && req.method === "POST") {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 50000) throw new Error("Too large"); chunks.push(chunk); }
        const { layout, extraValues } = JSON.parse(Buffer.concat(chunks).toString());
        if (keytagExtraLayoutError(layout)) throw new Error("Invalid layout");
        const paper = resolvePaperSize(layout.paperSize);
        const png = await renderKeytagDesigner(layout, { ...SAMPLE_DATA, extraValues } as any, paper.renderWidth, paper.renderHeight, 2);
        res.setHeader("Content-Type", "image/png"); res.end(png); return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html><head><title>Offline keytags</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    } catch (error) { console.error(error); res.writeHead(400).end("Fixture error"); }
  }).listen(8099, "0.0.0.0", () => console.log("Offline keytag fixture listening on 8099"));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
