const net=require("node:net");
const root=process.env.INVOICE_DUAL_SOCKET,port=Number(process.env.INVOICE_DUAL_PORT);
const ports=(process.env.INVOICE_DUAL_PORTS||String(port)).split(",").map(Number);
if(!ports.every(p=>Number.isInteger(p)&&p>1024&&p<65536)||new Set(ports).size!==ports.length)
  throw Error("Invalid disposable endpoints");
if(!/^\/tmp\/invoice-dual\.[A-Za-z0-9]+$/.test(root||"")||!Number.isInteger(port)||port<1025)
  throw Error("Disposable targets missing");
const deny=()=>{throw Error("Dual-store external network denied");};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const t=Array.isArray(args[0])?args[0][0]:args[0];
  const path=typeof t==="string"?t:t?.path;
  if(path!==`${root}/.s.PGSQL.5432`&&!(t?.host==="127.0.0.1"&&ports.includes(Number(t.port))))return deny();
  return connect.apply(this,args);
};
for(const mod of ["node:http","node:https"]){const api=require(mod);api.request=api.get=deny;}
require("node:tls").connect=deny;
globalThis.fetch=async()=>deny();
for(const api of [require("node:dns"),require("node:dns/promises")])
  for(const key of Object.keys(api))
    if(key==="lookup"||key==="lookupService"||key.startsWith("resolve"))api[key]=deny;
require("node:dgram").createSocket=deny;
