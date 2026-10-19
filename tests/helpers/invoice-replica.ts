import assert from "node:assert/strict";
import {MongoClient,Collection} from "mongodb";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import type {LocalDualMetadataStore} from "../../scripts/invoice-metadata-dual-store";

const root=process.env.INVOICE_DUAL_SOCKET!;
export const replicaPorts=process.env.INVOICE_DUAL_PORTS!.split(",").map(Number);
const direct=(port:number)=>new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`,
  {serverSelectionTimeoutMS:1000,socketTimeoutMS:2000});
export async function primary(excluded?:number) {
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    for(const port of replicaPorts.filter(p=>p!==excluded)){
      const client=direct(port);
      try {
        if((await client.db("admin").command({hello:1})).isWritablePrimary)return port;
      }catch{}finally{await client.close();}
    }
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error("Disposable replica did not elect a primary");
}
export async function initializeReplica(){
  const client=direct(replicaPorts[0]);
  try{
    await client.db("admin").command({replSetInitiate:{_id:"invoice_disposable",
      members:replicaPorts.map((p,i)=>({_id:i,host:`127.0.0.1:${p}`})),
      settings:{electionTimeoutMillis:1000}}});
  }finally{await client.close();}
  await primary();
}
export async function restartMember(port:number){
  const result=spawnSync("mongod",["--dbpath",`${root}/mongo-${port}`,"--bind_ip","127.0.0.1",
    "--port",String(port),"--nounixsocket","--replSet","invoice_disposable",
    "--setParameter","enableTestCommands=1","--wiredTigerCacheSizeGB","0.25","--fork",
    "--logpath",`${root}/mongo-${port}.log`,"--pidfilepath",`${root}/mongo-${port}.pid`],
    {timeout:20000,encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  // Require all members to catch up before the next fault; never kill a second
  // voter while the first is still recovering.
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    const client=direct(await primary());
    try{
      const s=await client.db("admin").command({replSetGetStatus:1});
      if(s.members.every((m:any)=>[1,2].includes(m.state))&&
        s.members.every((m:any)=>m.optime.ts.equals(s.members.find((x:any)=>x.state===1).optime.ts)))return;
    }finally{await client.close();}
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error("Replica failed to catch up");
}

/** Scoped driver-boundary injection; never changes the CAS or its write concern. */
export async function losePrimaryAtShadow(
  store:LocalDualMetadataStore,mode:"before-cas"|"after-majority",work:()=>Promise<void>,
){
  const port=await primary(),admin=direct(port);
  const original=Collection.prototype.updateOne;
  let fired=false;
  Collection.prototype.updateOne=async function(this:Collection,...args:any[]){
    if(this.collectionName!=="owners"||!args[1]?.$set?.receipt?.id?.match(/:1:(apply|rollback)$/))
      return original.apply(this,args as any);
    assert.equal(fired,false);fired=true;
    assert.equal(args[2].writeConcern.w,"majority");
    if(mode==="before-cas"){
      const fp=await admin.db("admin").command({configureFailPoint:"failCommand",mode:{times:1},
        data:{failCommands:["update"],blockConnection:true,blockTimeMS:15000}});
      const pending=original.apply(this,args as any).then(()=>({ok:true}),error=>({ok:false,error}));
      await admin.db("admin").command({waitForFailPoint:"failCommand",timesEntered:fp.count+1,maxTimeMS:5000});
      // The server has received the command, but failCommand blocks execution.
      process.kill(Number(readFileSync(`${root}/mongo-${port}.pid`,"utf8")),"SIGKILL");
      assert.equal((await pending).ok,false,"Killed in-flight update must not be acknowledged");
    }else{
      const result=await original.apply(this,args as any);
      assert.equal(result.modifiedCount,1);
      // Majority acknowledged by the driver, deliberately withheld from caller.
      process.kill(Number(readFileSync(`${root}/mongo-${port}.pid`,"utf8")),"SIGKILL");
    }
    throw Error(`Unknown shadow outcome: ${mode}`);
  } as any;
  try{
    await assert.rejects(work());
    assert.equal(fired,true,"Must reach the real shadow CAS");
  }finally{
    Collection.prototype.updateOne=original;
    await admin.close();
  }
  const elected=await primary(port);
  assert.notEqual(elected,port);
  return port;
}
