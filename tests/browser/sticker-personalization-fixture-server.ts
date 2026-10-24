import http from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

async function start() {
  const result = await build({ entryPoints: ["tests/browser/sticker-personalization-fixture.tsx"],
    bundle: true, write: false, jsx: "automatic", platform: "browser", outdir: "/tmp/sticker-personalization" });
  const js = result.outputFiles.find(f => f.path.endsWith(".js"))!.text;
  const css = (await postcss([tailwindcss()]).process(
    '@import "tailwindcss" source(none); @source "../../app/dashboard/settings/stickers/page.tsx"; @source "../../components/sticker-designer"; @source "../../components/stickers";',
    { from: "tests/browser/sticker-fixture.css" })).css;
  let config: any = { tagline: "We appreciate your business", personalizeThankYou: false, openPrintTabFirst: false };
  http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(js); return; }
    if (req.url?.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/sticker/settings") {
        if (req.method === "PUT") {
          let body = ""; for await (const chunk of req) body += chunk;
          config = { ...config, ...JSON.parse(body) };
        }
        res.end(JSON.stringify({ success: true, config })); return;
      }
      res.end(JSON.stringify({ shops: [], supply: null, canManage: false })); return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><style>body{font-family:Arial;background:#f8fafc}${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  }).listen(8099, "0.0.0.0", () => console.log("Offline sticker personalization fixture on 8099"));
}
void start();
