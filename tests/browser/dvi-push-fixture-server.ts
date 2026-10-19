// Standalone component fixture. Never boots Next or imports server repositories.
import http from "node:http";
import { build } from "esbuild";
async function main() {
  const bundle = await build({
    entryPoints: ["tests/browser/dvi-push-fixture.tsx"], bundle: true, write: false,
    jsx: "automatic", platform: "browser", format: "iife",
  });
  const requestBundle = await build({
    entryPoints: ["tests/browser/dvi-request-fixture.tsx"], bundle: true, write: false,
    jsx: "automatic", platform: "browser", format: "iife",
    plugins: [{name: "isolate-visit", setup(build) {
      build.onResolve({filter: /components\/auto-dvi\/VisitInspectionPanel$/}, () => ({path: "visit", namespace: "fixture"}));
      build.onLoad({filter: /.*/, namespace: "fixture"}, () => ({contents: "export default function Visit(){return null}"}));
    }}],
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Offline DVI outcomes</title>
  <style>body{font:16px system-ui;background:#f8fafc;color:#182235;margin:32px}main{max-width:850px;margin:auto}
  section{background:white;padding:24px;margin:22px 0;border:1px solid #ddd;border-radius:12px}
  h1{font-size:26px}h2{font-size:18px}.text-sm{font-size:14px}.border{border:1px solid}
  .rounded-lg{border-radius:8px}.px-3{padding-left:12px;padding-right:12px}.py-2{padding-top:8px;padding-bottom:8px}
  .text-amber-900{color:#78350f}.bg-amber-50{background:#fffbeb}.border-amber-300{border-color:#fcd34d}
  .block{display:block}button{padding:10px 16px;margin-top:16px}</style></head>
  <body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
  http.createServer((req, res) => {
    if (req.url?.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/api/auto-dvi/push/status")) {
        res.end(JSON.stringify({ok: true, durable: true, scopeKey: "offline-fixture", vin: "1HGCM82633A004352",
          workOrderGuid: "11111111-1111-4111-8111-111111111111", operation: {operationId: "offline-pending"}}));
      } else if (req.url === "/api/auto-dvi/generate") {
        res.end(JSON.stringify({items: [{id: "a", name: "Battery", lineTitle: "Inspected: Battery", source: "vhi"}]}));
      } else res.end('{"items":[]}');
      return;
    }
    if (req.url === "/requests.js") {
      res.setHeader("Content-Type", "text/javascript"); res.end(requestBundle.outputFiles[0].text); return;
    }
    if (req.url === "/requests") {
      res.setHeader("Content-Type", "text/html");
      res.end(html.replace('/fixture.js', '/requests.js').replace('</body>',
        `<script>const openPanel=setInterval(()=>{const b=document.querySelector('button');if(b){clearInterval(openPanel);b.click()}},50)</script></body>`));
      return;
    }
    res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html");
    res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : html);
  }).listen(5000, "0.0.0.0", () => console.log("Offline DVI fixture listening on 5000"));
}
main();
