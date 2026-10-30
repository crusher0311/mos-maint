import http from "node:http";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { emptyTireResult, extractTireInvoice, tireCsv, validateTireDefinition } from "../../lib/tire-dot-report";

export async function createTireFixture() {
  const js = await build({ entryPoints: ["tests/browser/tire-dot-fixture.tsx"], bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife" });
  let polls = 0, posts = 0, downloads = 0, denied = false, mode = "normal";
  const makeResult = () => {
    const definition = validateTireDefinition({ dateRange: { start: "2024-08-14", end: "2024-08-14" }, locationIds: [311, 32] });
    const r = emptyTireResult(definition, [{ shopId: 311, name: "Fixture North" }, { shopId: 32, name: "Fixture South" }]);
    for (let i = 0; i < (mode === "empty" ? 0 : 52); i++) extractTireInvoice(r, i % 2 ? 32 : 311, { workOrderId: String(i), data: {
      id: i, repairOrderNumber: `000${i}`, repairOrderStatus: "Posted", postedDate: "2024-08-14T12:00:00Z",
      milesIn: i === 0 ? null : 59663, vehicle: { vin: "FIXTUREVIN", year: 2020, make: "Example", model: "Car" },
      jobs: [{ id: 1, authorized: true, parts: [{ id: 1, name: "Pirelli tire", quantity: 2, dotNumbers: i === 0 ? [] : ["001234", "001234"] }] }],
    } });
    r.generatedAt = "2026-10-30T12:00:00Z"; return r;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    res.setHeader("Cache-Control", "no-store");
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value)); };
    if (url.pathname === "/fixture/control") { denied = url.searchParams.get("deny") === "true"; mode = url.searchParams.get("mode") || "normal"; json({ posts, polls, downloads }); return; }
    if (url.pathname === "/fixture/stats") { json({ posts, polls, downloads }); return; }
    if (url.pathname === "/api/reports/tire-dot/locations") { json(denied ? { error: "Access revoked" } : { locations: [{ shopId: 311, name: "Fixture North" }, { shopId: 32, name: "Fixture South" }] }, denied ? 403 : 200); return; }
    if (url.pathname === "/api/reports/runs") {
      posts++; polls = 0;
      json({ runId: "fixture-run", status: "queued", stage: "queued" }, 202); return;
    }
    if (url.pathname === "/api/reports/tire-dot/runs/fixture-run") {
      polls++;
      if (denied) json({ error: "Access revoked" }, 403);
      else if (mode === "failed") json({ runId: "fixture-run", status: "failed", stage: "failed", error: "Fixture extraction failed" });
      else json(polls < 2 ? { runId: "fixture-run", status: "running", stage: "extracting" } : { runId: "fixture-run", status: "succeeded", stage: "complete", result: makeResult(), stale: true });
      return;
    }
    if (url.pathname === "/api/reports/export") {
      downloads++;
      if (denied) json({ error: "Access revoked" }, 403);
      else if (mode === "preparing") json({ error: "Report is still preparing" }, 202);
      else res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=fixture.csv" }).end(tireCsv(makeResult(), url.searchParams.get("view") === "invoices" ? "invoices" : "details"));
      return;
    }
    if (url.pathname === "/app.js") { res.writeHead(200, { "Content-Type": "text/javascript" }).end(js.outputFiles[0].text); return; }
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline Tire DOT verification</title><style>
      *{box-sizing:border-box}body{margin:0;background:#f4f7fa;color:#0f172a;font:14px system-ui}main{max-width:1400px;margin:auto;padding:24px}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.panel{background:#fff;border:1px solid #dbe5ee;border-radius:8px;padding:18px;margin-bottom:18px}.action{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:5px;border:1px solid #cbd5e1;margin:4px}.primary{background:#347bbd;color:white}.secondary{background:white;color:#174b78}.filter{display:block;padding:8px;border:1px solid #cbd5e1;border-radius:4px;margin:6px 0}svg{width:16px;height:16px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e2e8f0;padding:10px;text-align:left;font-size:12px}th{background:#edf7fd}fieldset{margin:12px 0;padding:12px}label{display:inline-block;margin:6px 12px 6px 0}p{line-height:1.6}.overflow-x-auto{overflow-x:auto}.flex{display:flex;gap:10px;flex-wrap:wrap}.grid{display:grid;gap:12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.space-y-4> *+*{margin-top:16px}button[aria-selected=true]{background:#edf7fd;color:#174b78}details{margin-top:20px}h2{margin:0 0 12px}
      </style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createTireFixture().then(server => server.listen(5012, "0.0.0.0", () => console.log("Offline Tire DOT fixture ready on 5012")));
}
