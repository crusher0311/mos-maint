// Isolated visual fixture. No application imports, secrets, auth bypass, or DB.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const assets = new Map([
  ["/tutorials.js", "mos-tools-extension/tutorials.js"],
  ["/tutorials.css", "mos-tools-extension/tutorials.css"],
]);
createServer(async (req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  if (assets.has(path)) {
    res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "text/css");
    res.end(await readFile(assets.get(path))); return;
  }
  if (path !== "/") { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Isolated tutorial preview</title><link rel="stylesheet" href="/tutorials.css">
    <style>body{font:14px system-ui;background:#f8fafc;color:#24425b;margin:20px}main{max-width:600px}button{padding:10px}section{padding:18px;background:white;margin-top:20px;border:1px solid #dbe4ec;border-radius:8px}</style>
    <main><h1>Detect Dog help preview</h1><p>Isolated fixture — no customer data or connected services.</p>
    <button id="help">Help &amp; tutorials</button><section id="has-context">Example vehicle context</section>
    <section id="plan-content"><h2>VHI recommendations</h2><p>Guide controls never refresh, add jobs, send or print.</p></section></main>
    <script type="module">
      import {createTutorials} from '/tutorials.js';
      const state={noticeSeen:true,dismissed:[],completed:[]};
      const help=createTutorials({surface:'extension',
        getContext:()=>({authenticated:true,features:['maintenance','job_lookup','oil_sticker'],current:'vhi',scope:'fixture'}),
        request:async()=>({personId:null,persistent:false,canSave:false,state})});
      document.querySelector('#help').onclick=()=>help.open();
      // Visual fixture only: open the browser, never a walkthrough.
      help.open();
    </script></html>`);
}).listen(8098, "0.0.0.0", () => console.log("Isolated tutorial preview on 8098"));
