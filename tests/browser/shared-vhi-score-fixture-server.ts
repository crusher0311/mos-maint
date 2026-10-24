// Isolated visual fixture: imports no app server, stores, or credentials.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

async function main() {
  const result = await build({
    entryPoints: ["tests/browser/shared-vhi-score-fixture.tsx"],
    bundle: true, write: false, jsx: "automatic", platform: "browser",
  });
  const css = await postcss([tailwindcss()]).process(
    '@import "tailwindcss" source(none); @source "../../components/vehicle-health-report";',
    { from: "tests/browser/shared-vhi-score-fixture.css" },
  );
  http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(result.outputFiles[0].text);
    } else if (req.url?.startsWith("/icons/") || req.url?.startsWith("/logos/")) {
      const file = path.resolve("public", `.${req.url}`);
      if (!file.startsWith(path.resolve("public") + "/") || !fs.existsSync(file)) {
        res.writeHead(404).end(); return;
      }
      res.setHeader("Content-Type", file.endsWith(".svg") ? "image/svg+xml" : "image/png");
      res.end(fs.readFileSync(file));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html><head><style>${css.css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    }
  }).listen(3003, "0.0.0.0", () => console.log("Offline shared VHI fixture on 3003"));
}
main().catch(error => { console.error(error); process.exit(1); });
