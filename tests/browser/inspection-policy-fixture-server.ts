import http from "node:http";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {randomUUID} from "node:crypto";
import {isolatedStaffDatabase} from "../helpers/staff-inspection-fixture";
import {MongoSheetCatalog} from "../../lib/data/repositories/inspection-sheet-catalog";
import {readCatalog, updateCatalog, type CatalogDependencies} from "../../lib/auto-dvi/staff/sheet-catalog";
import {STAFF_SHEET_TEMPLATES} from "../../lib/auto-dvi/staff/model";

export async function createPolicyFixture() {
  const isolated = await isolatedStaffDatabase(27940);
  const db = isolated.client.db(`policy_browser_${randomUUID().replaceAll("-", "")}`);
  const deps: CatalogDependencies = {
    access: async () => ({key: "shop:1", shopId: 1, actor: "synthetic-manager", scope: "shop",
      scopeLabel: "Synthetic inspection shop", canManage: true}),
    store: new MongoSheetCatalog(async () => db),
  };
  await updateCatalog({requestId: randomUUID(), revision: 0, command: {type: "save",
    sheet: {...STAFF_SHEET_TEMPLATES[0], version: 0}, makeDefault: true}}, deps);
  const bundle = await build({entryPoints: ["tests/browser/inspection-policy-fixture.tsx"],
    bundle: true, write: false, outdir: "generated-artifacts/policy-browser",
    jsx: "automatic", platform: "browser", format: "iife"});
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reply = (value: unknown, status = 200) => {
      res.writeHead(status, {"Content-Type": "application/json"}); res.end(JSON.stringify(value));
    };
    try {
      if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated DVI policy settings</title><link rel="stylesheet" href="/fixture.css"><style>body{font:15px system-ui;margin:16px;background:#f4f6f5;color:#20372d}main{max-width:1100px;margin:auto}button,input,select{font:inherit}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
      } else if (req.url === "/fixture.js" || req.url === "/fixture.css") {
        const extension = req.url.endsWith(".js") ? ".js" : ".css";
        res.setHeader("Content-Type", extension === ".js" ? "text/javascript" : "text/css");
        res.end(bundle.outputFiles.find(f => f.path.endsWith(extension))?.text ?? "");
      } else if (req.url === "/api/shop-dispatch/inspection/sheets" && req.method === "GET") {
        reply(await readCatalog(deps));
      } else if (req.url === "/api/shop-dispatch/inspection/sheets" && req.method === "POST") {
        const parts: Buffer[] = []; let total = 0;
        for await (const part of req) {
          total += part.length; if (total > 300_000) throw Error("Fixture request too large");
          parts.push(part);
        }
        reply(await updateCatalog(JSON.parse(Buffer.concat(parts).toString("utf8")), deps));
      } else if (req.url === "/favicon.ico") res.writeHead(204).end();
      else reply({error: "Only isolated inspection catalog operations are supported"}, 404);
    } catch (error) {
      reply({error: error instanceof Error ? error.message : "Fixture failed"}, (error as {status?: number}).status ?? 503);
    }
  });
  return {server, deps, async close() {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await isolated.close();
  }};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void createPolicyFixture().then(f => {
    f.server.listen(3003, "0.0.0.0", () => console.log("Isolated DVI policy fixture ready on 3003"));
    process.once("SIGTERM", () => {void f.close().then(() => process.exit(0));});
  });
}
