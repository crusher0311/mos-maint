/**
 * One explicitly approved diagnostic GET. No DB writes, token refresh, retries,
 * provider writes, or raw/customer payload persistence. A local attempt marker
 * prevents accidental repeat requests.
 */
import { MongoClient } from "mongodb";
import { mkdir, writeFile } from "node:fs/promises";
const output = "generated-artifacts/heart-tire-dot-validation/northbrook-known-dot";
async function main() {
  const client = new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`, {maxPoolSize:1,serverSelectionTimeoutMS:10000});
  try {
    const vehicleList=process.argv.includes("--compare-vehicle-list");
    const listMode=vehicleList||process.argv.includes("--compare-list");
    await client.connect();
    const db=client.db("mos-maintenance-mvp");
    const enterprise=await db.collection("enterprise_accounts").findOne({name:"HEART Certified Auto Care"},{projection:{shopIds:1},maxTimeMS:3000});
    const shops=await db.collection("shops").find({shopId:{$in:[37,"37"]}},{projection:{shopId:1,integrationProvider:1,"tekmetric.shopId":1},maxTimeMS:3000}).limit(2).toArray();
    if(!enterprise?.shopIds.map(Number).includes(37)||shops.length!==1||Number(shops[0].tekmetric?.shopId)!==471||
      (shops[0].integrationProvider&&shops[0].integrationProvider!=="tekmetric"))throw new Error("Shop scope mismatch");
    const stored=await db.collection("tekmetric_work_orders").find({shopId:{$in:[37,"37"]},workOrderId:{$in:["360572784",360572784]}},
      {projection:{"data.id":1,"data.shopId":1,"data.vehicleId":1,"data.repairOrderNumber":1,"data.jobs.parts":1,fetchedAt:1},maxTimeMS:3000}).hint("shopId_workOrderId").limit(2).toArray();
    if(stored.length!==1||Number(stored[0].data?.repairOrderNumber)!==853078267||Number(stored[0].data?.shopId)!==471)
      throw new Error("Stored identity mismatch");
    const credential=await db.collection("tekmetric_tokens").findOne({tokenKey:"current"},
      {projection:{accessToken:1,expiresAt:1},maxTimeMS:3000});
    if(!credential?.accessToken||Date.parse(credential.expiresAt)<Date.now()+60000)throw new Error("No fresh existing token; no provider call made");
    await mkdir(output,{recursive:true,mode:0o700});
    if(listMode&&!Number.isSafeInteger(stored[0].data.vehicleId))throw new Error("Stored identity mismatch");
    const suffix=vehicleList?"-vehicle-list":listMode?"-list":"";
    await writeFile(`${output}/request-attempt${suffix}.json`,JSON.stringify({attemptedAt:new Date().toISOString(),method:"GET",providerRoId:360572784,providerShopId:471}),{flag:"wx",mode:0o600});
    const url=listMode?`https://shop.tekmetric.com/api/v1/repair-orders?shop=471&vehicleId=${stored[0].data.vehicleId}&size=20${vehicleList?"":"&updatedDateStart=2026-09-02&updatedDateEnd=2026-09-03"}`
      :"https://shop.tekmetric.com/api/v1/repair-orders/360572784";
    const response=await fetch(url,{
      method:"GET",redirect:"error",headers:{Authorization:`Bearer ${credential.accessToken}`,Accept:"application/json"},signal:AbortSignal.timeout(15000),
    });
    if(!response.ok){await response.body?.cancel();throw new Error(`Provider HTTP ${response.status}; no retry`);}
    const reader=response.body!.getReader(); const chunks:Uint8Array[]=[];let bytes=0;
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>3000000){await reader.cancel();throw new Error("Response limit reached");}chunks.push(value);}
    const parsed=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const raw=listMode?parsed.content?.find((r:any)=>r.id===360572784):parsed;
    if(!raw)throw new Error("Provider response identity mismatch");
    if(raw.id!==360572784||raw.shopId!==471||raw.repairOrderNumber!==853078267)throw new Error("Provider response identity mismatch");
    const parts=(ro:any)=>(ro.jobs||[]).flatMap((j:any)=>(j.parts||[]).map((p:any)=>({
      jobId:j.id,partId:p.id,quantity:p.quantity,brand:p.brand,hasDotField:Object.hasOwn(p,"dotNumbers"),
      dotNumbers:Array.isArray(p.dotNumbers)?p.dotNumbers:null,dotFieldType:typeof p.dotNumbers,
    })));
    const evidence={checkedAt:new Date().toISOString(),invoice:raw.repairOrderNumber,providerRoId:raw.id,providerShopId:raw.shopId,
      providerUpdatedDate:raw.updatedDate,storedFetchedAt:stored[0].fetchedAt,storedParts:parts(stored[0].data),liveParts:parts(raw)};
    await writeFile(`${output}/comparison${suffix}.json`,JSON.stringify(evidence,null,2),{mode:0o600});
    console.log(JSON.stringify(evidence));
  }finally{await client.close();}
}
main().catch(e=>{console.error(e instanceof Error&&/^(Shop scope|Stored identity|No fresh|Provider HTTP|Response limit|Provider response)/.test(e.message)?e.message:(e.code||e.name||"Diagnostic failed"));process.exitCode=1;});
