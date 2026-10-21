// Imported only by the offline smoke test. No Next server or real auth is booted.
import http from "node:http";
import {AsyncLocalStorage} from "node:async_hooks";
import {createHash,randomUUID} from "node:crypto";
import {build} from "esbuild";
import {isolatedStaffDatabase} from "../helpers/staff-inspection-fixture";
import {STAFF_SHEET_TEMPLATES} from "../../lib/auto-dvi/staff/model";

export async function transferFixture(){
  // Compile before allocating a database process, so build failures cannot leak it.
  const bundle=await build({entryPoints:["tests/browser/check-in-transfer-recovery-fixture.tsx"],
    bundle:true,write:false,jsx:"automatic",platform:"browser",format:"iife"});
  const isolated=await isolatedStaffDatabase(27848);
  let server:http.Server|undefined;
  try{
  const db=isolated.client.db("transfer_browser");
  const context=new AsyncLocalStorage<string|undefined>();
  const sessions=new Map<string,string>(["sender","recipient"].map((name):[string,string]=>[randomUUID(),`${name}@example.invalid`]));
  const actor=(email:string)=>createHash("sha256").update(`staff|66|${email}`).digest("hex");
  const Module=require("module"),original=Module._load;
  Module._load=function(id:string,...args:any[]){
    if(id==="next/headers")return {cookies:async()=>({get:()=>context.getStore()?{value:context.getStore()}:undefined})};
    if(id==="@/lib/auth")return {getSession:async()=>{
      const token=context.getStore(),email=token&&sessions.get(token);
      return email?{email,shopId:66,token}:null;
    }};
    if(id==="@/lib/data/db"||id==="@/lib/mongo")return {getDb:async()=>db};
    if(id==="@/lib/data/repositories/users")return {listUsers:async(q:any)=>
      [...sessions.values()].filter(email=>email===q.email).map(email=>({email,shopId:66,role:"advisor",status:"active"}))};
    if(id==="@/lib/enterprise")return {getEnterpriseByShopId:async()=>null};
    if(id==="@/lib/featureResolver")return {getFeatureEntitlements:async()=>({isFeatureEnabled:()=>true})};
    if(id==="@/lib/data/repositories/workflow-inspections")return {
      ...original.call(this,id,...args),
      readStaffConfiguration:async()=>({version:1,enabledShopIds:[66],sheets:[STAFF_SHEET_TEMPLATES[0]],
        defaultSheet:`${STAFF_SHEET_TEMPLATES[0].id}@${STAFF_SHEET_TEMPLATES[0].version}`,rules:{},individual:{}}),
    };
    return original.call(this,id,...args);
  };
  let drafts:any,transfers:any;
  try{
    drafts=require("../../app/api/dashboard/protractor/check-in-drafts/route");
    transfers=require("../../app/api/dashboard/protractor/check-in-drafts/transfer/route");
  }finally{Module._load=original;}
  const requests:Array<{email?:string;path:string;body:any;status:number}>=[];
  let loseAcceptance=false;
  const listener=server=http.createServer(async(req,res)=>{
    const token=/session_token=([^;]+)/.exec(req.headers.cookie??"")?.[1];
    await context.run(token,async()=>{
      try{
        const url=new URL(req.url!,"http://"+req.headers.host);
        if(url.pathname==="/favicon.ico"){res.writeHead(204);res.end();return;}
        if(url.pathname==="/fixture.js"){res.setHeader("Content-Type","text/javascript");res.end(bundle.outputFiles[0].text);return;}
        if(url.pathname==="/"){
          res.setHeader("Content-Type","text/html");
          res.end('<!doctype html><meta name="viewport" content="width=device-width"><style>body{font:16px system-ui;margin:20px}button,input{max-width:100%;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><div id="root"></div><script src="/fixture.js"></script>');return;
        }
        const email=token?sessions.get(token):undefined;
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
        const text=Buffer.concat(chunks).toString(),body=text?JSON.parse(text):undefined;
        let response:Response;
        if(url.pathname==="/api/dashboard/protractor/dvi-handoff"&&req.method==="GET"){
          response=Response.json(email?{shopId:66,actorKey:actor(email),enabled:true,sharedDrafts:{version:1}}:{error:"Sign in required"},
            {status:email?200:401});
        }else{
          const handler=url.pathname==="/api/dashboard/protractor/check-in-drafts"?drafts:
            url.pathname==="/api/dashboard/protractor/check-in-drafts/transfer"?transfers:null;
          if(!handler||!["GET","POST"].includes(req.method!))response=Response.json({error:"Unexpected offline request"},{status:404});
          else response=await handler[req.method!](new Request(url,{method:req.method,headers:req.headers as HeadersInit,
            ...(text?{body:text}:{})}));
        }
        requests.push({email,path:url.pathname,body,status:response.status});
        if(loseAcceptance&&body?.action==="accept"&&response.ok){
          loseAcceptance=false;
          // Fail after commit and response headers: Chromium must not silently retry.
          res.writeHead(200,{"Content-Type":"application/json","Content-Length":"1000"});
          res.write('{"draft":');setTimeout(()=>res.destroy(),20);return;
        }
        res.writeHead(response.status,Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
    });
  });
  await new Promise<void>((resolve,reject)=>{
    listener.once("error",reject);
    listener.listen(0,"127.0.0.1",()=>{listener.off("error",reject);resolve();});
  });
  const port=(listener.address() as import("node:net").AddressInfo).port;
  return {url:`http://127.0.0.1:${port}`,db,requests,actor,
    token:(name:string)=>[...sessions].find(([,email])=>email===`${name}@example.invalid`)![0],
    loseAcceptance:()=>{loseAcceptance=true;},
    async close(){
      try{await new Promise<void>((resolve,reject)=>listener.close(e=>e?reject(e):resolve()));}
      finally{await isolated.close();}
    }};
  }catch(error){
    if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await isolated.close();
    throw error;
  }
}
