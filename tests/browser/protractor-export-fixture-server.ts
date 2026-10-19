import http from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

export async function exportFixture() {
  const result = await build({ entryPoints: ["tests/browser/protractor-export-fixture.tsx"],
    bundle: true, write: false, outdir: "/tmp/export-fixture", jsx: "automatic", platform: "browser",
    plugins: [{ name: "offline-next-link", setup(b) {
      b.onResolve({filter:/^next\/link$/},()=>({path:"link",namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:'import React from "react";export default function Link(p){return React.createElement("a",p)}',loader:"js",resolveDir:process.cwd()}));
    } }] });
  const js=result.outputFiles.find(f=>f.path.endsWith(".js"))!.text;
  const utilities = await postcss([tailwindcss()]).process(
    '@import "tailwindcss" source(none); @source "../../app/dashboard/enterprise/exports/page.tsx";',
    {from:"tests/browser/export-fixture.css"});
  const css=utilities.css+(result.outputFiles.find(f=>f.path.endsWith(".css"))?.text??"");
  return http.createServer((req,res)=>{
    res.setHeader("Cache-Control","no-store");
    if(req.url==="/fixture.js"){res.setHeader("Content-Type","text/javascript");res.end(js);return;}
    if(req.url?.startsWith("/api/")){
      res.setHeader("Content-Type","application/json");
      if(req.url==="/api/enterprise"){res.end(JSON.stringify({enterprise:{id:"0123456789abcdef01234567",name:"Fixture Enterprise"}}));return;}
      res.end(JSON.stringify({enterprise:{id:"0123456789abcdef01234567",name:"Fixture Enterprise"},
        shops:[{shopId:1,name:"Fictional Service Shop"}],config:null,status:[],history:[],workerAvailable:false,enabled:false}));return;
    }
    res.setHeader("Content-Type","text/html");
    res.end(`<!doctype html><html><head><style>body{font-family:Arial;margin:0;background:#f7f8fa}${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
}
if (process.argv[1]?.endsWith("protractor-export-fixture-server.ts"))
  exportFixture().then(server=>server.listen(8099,"0.0.0.0",()=>console.log("Offline export fixture on 8099")));
