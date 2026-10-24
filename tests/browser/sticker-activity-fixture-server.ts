import http from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

async function start() {
  const result = await build({ entryPoints: ["tests/browser/sticker-activity-fixture.tsx"], bundle: true,
    write: false, jsx: "automatic", platform: "browser", outdir: "/tmp/sticker-fixture" });
  const js = result.outputFiles.find(f => f.path.endsWith(".js"))!.text;
  const css = (await postcss([tailwindcss()]).process(
    '@import "tailwindcss" source(none); @source "../../components/stickers/StickerSupply.tsx"; @source "../../app/platform-admin/shops/page.tsx";',
    { from: "tests/browser/sticker-fixture.css" })).css;
  let supply = { enabled: true, capacity: 200, threshold: 190, used: 192, revision: "fixture", low: true };
  http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(js); return; }
    if (req.url?.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/sticker/supply") {
        if (req.method === "POST") {
          let text = ""; for await (const chunk of req) text += chunk;
          const input = JSON.parse(text);
          if (input.revision !== supply.revision) { res.statusCode = 409; res.end("{}"); return; }
          supply = { ...supply, ...(input.operation === "reset" ? { used: 0 } : input), revision: String(Date.now()) };
          supply.low = supply.enabled && supply.used >= supply.threshold;
          res.end('{"success":true}'); return;
        }
        res.end(JSON.stringify({ supply, canManage: true })); return;
      }
      res.end(JSON.stringify({ ok: true, shops: [
        { _id: "fixture1", shopId: 1, name: "Fictional Service Shop", createdAt: "2026-01-01", userCount: 1, vehicleCount: 0,
          integrations: [], billing: { plan: "starter", status: "active", isPaid: true, vinViewCount: 0 },
          stickerActivity: { state: "recorded", lastAt: "2026-10-01T12:00:00Z", evidence: "legacy-generation", inactive: true, sortAt: "2026-10-01T12:00:00Z" } },
      ] })); return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><style>body{font-family:Arial;background:#f8fafc}${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  }).listen(8098, "0.0.0.0", () => console.log("Isolated sticker fixture on 8098"));
}
void start();
