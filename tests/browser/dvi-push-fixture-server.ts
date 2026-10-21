// Standalone component fixture. Never boots Next or imports server repositories.
import http from "node:http";
import { build } from "esbuild";
async function main() {
  const transferBundle=await build({entryPoints:["tests/browser/check-in-transfer-fixture.tsx"],bundle:true,write:false,
    jsx:"automatic",platform:"browser",format:"iife"});
  let transferOffered=false,transferRevision=1;
  const recoveryBundle = await build({
    entryPoints: ["tests/browser/dvi-recovery-fixture.tsx"], bundle: true, write: false,
    jsx: "automatic", platform: "browser", format: "iife",
  });
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
    if(req.url==="/transfer.js"){res.setHeader("Content-Type","text/javascript");res.end(transferBundle.outputFiles[0].text);return;}
    if(req.url==="/transfer"){res.setHeader("Content-Type","text/html");res.end(html.replace("/fixture.js","/transfer.js"));return;}
    if(req.url?.startsWith("/api/dashboard/protractor/check-in-drafts/transfer")){
      res.setHeader("Content-Type","application/json");
      if(req.method==="POST"){
        let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{
          const input=JSON.parse(body);transferOffered=input.action==="offer";transferRevision++;
          res.end(JSON.stringify({draft:{revision:transferRevision}}));
        });return;
      }
      if(req.url.includes("?email=")){res.end(JSON.stringify({coworker:{email:"recipient@example.invalid",actor:"b".repeat(64)}}));return;}
      res.end(JSON.stringify({offers:transferOffered?[{id:"14850000-0000-4000-8000-000000000001",revision:transferRevision,
        from:"a".repeat(64),offeredAt:"2026-10-20T12:00:00Z"}]:[]}));return;
    }
    if (req.url?.startsWith("/api/")) {
      if (req.url.startsWith("/api/auto-dvi/push/recover")) {
        res.writeHead(403, {"Content-Type": "application/json"});
        res.end(JSON.stringify({error: "OFFLINE_FIXTURE_NO_AUTHORITY"})); return;
      }
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
    res.setHeader("Content-Type", req.url?.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text :
      req.url === "/recovery.js" ? recoveryBundle.outputFiles[0].text :
      req.url === "/recovery" ? html.replace("/fixture.js", "/recovery.js") : html);
  }).listen(5000, "0.0.0.0", () => console.log("Offline DVI fixture listening on 5000"));
}
main();
