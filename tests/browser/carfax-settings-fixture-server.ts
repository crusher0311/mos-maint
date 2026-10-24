import http from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(name: string, ...args: any[]) {
  if (name === "@/lib/auth") return { requireSession: async () => ({ shopId: 123 }) };
  if (name === "next/navigation") return { redirect: (url: string) => { throw { fixtureRedirect: url }; } };
  return originalLoad.call(this, name, ...args);
};
const dedicatedPage = require("../../app/dashboard/settings/carfax/page").default;
Module._load = originalLoad;

async function main() {
  const result = await build({
    entryPoints: ["tests/browser/carfax-settings-fixture.tsx"], bundle: true, write: false,
    jsx: "automatic", platform: "browser",
    plugins: [{ name: "isolate-status-panel", setup(b) {
      b.onResolve({ filter: /^@\/components\/DataStatusPanel$/ }, () => ({ path: "panel", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export default function Panel(){return null}", loader: "js" }));
    } }],
  });
  const css = (await postcss([tailwindcss()]).process(
    '@import "tailwindcss" source(none); @source "../../app/dashboard/settings/integrations/page.tsx";',
    { from: "tests/browser/carfax-fixture.css" },
  )).css;
  http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/dashboard/settings/carfax") {
      try { await dedicatedPage(); } catch (error: any) {
        if (error.fixtureRedirect) { res.writeHead(307, { Location: error.fixtureRedirect }); res.end(); return; }
        res.writeHead(500); res.end("Fixture failure"); return;
      }
    }
    if (req.url === "/app.js") { res.setHeader("Content-Type", "application/javascript"); res.end(result.outputFiles[0].text); }
    else { res.setHeader("Content-Type", "text/html"); res.end(`<html><head><style>${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`); }
  }).listen(5115, "0.0.0.0", () => console.log("Offline CARFAX fixture ready on 5115"));
}
main();
