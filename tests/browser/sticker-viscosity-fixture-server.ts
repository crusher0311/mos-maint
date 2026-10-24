import http from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
async function start() {
  const result = await build({ entryPoints: ["tests/browser/sticker-viscosity-fixture.tsx"],
    bundle: true, write: false, jsx: "automatic", platform: "browser", outdir: "/tmp/sticker-viscosity" });
  const js = result.outputFiles.find(f => f.path.endsWith(".js"))!.text;
  const css = (await postcss([tailwindcss()]).process(
    '@import "tailwindcss" source(none); @source "../../components/sticker-designer"; @source "../../components/stickers";',
    { from: "tests/browser/sticker-fixture.css" })).css;
  http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(js); return; }
    if (req.url?.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ config: { defaultSize: "2x2" }, configured: false, supply: null, canManage: false }));
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><style>body{font-family:Arial;background:#f8fafc}${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  }).listen(8099, "0.0.0.0", () => console.log("Offline viscosity fixture on 8099"));
}
void start();
