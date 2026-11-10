/** Separately gated read-only inventory. Never invokes providers or writes source data. */
import {readFile,writeFile} from "node:fs/promises";
import postgres from "postgres";
import {MongoClient} from "mongodb";
import {collectRecoveryInventory} from "./lib/telle-recovery-inventory";
import {sourceRows} from "./lib/telle-retained-reader";
import {validateReferences} from "./lib/telle-recovery-review";
async function main(){
  const [mode,input,captureFile,output,...extra]=process.argv.slice(2);
  if(mode!=="--approved-read"||!output||extra.length||process.env.TELLE_RECOVERY_INVENTORY_ENABLED!=="true"||
    process.env.NODE_ENV!=="production")throw Error("inventory_disabled");
  const refs=JSON.parse(await readFile(input,"utf8"));validateReferences(refs);
  const captures=JSON.parse(await readFile(captureFile,"utf8"));
  if(!Array.isArray(captures)||captures.length>233||captures.some(c=>c.shopId!==282))throw Error("capture_scope_invalid");
  if(!process.env.SUPABASE_PROD_DATABASE_URL||!process.env.MONGODB_USERNAME||!process.env.MONGODB_PASSWORD)
    throw Error("source_connections_required");
  const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL,{max:1,ssl:"require",connect_timeout:5,onnotice:()=>{},
    connection:{default_transaction_read_only:true,statement_timeout:3000}});
  const mongo=new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp`,
    {maxPoolSize:1,retryWrites:false,serverSelectionTimeoutMS:5000,socketTimeoutMS:5000});
  try{
    await mongo.connect();const db=mongo.db();
    const shops=await db.collection("shops").find({shopId:{$in:[282,"282"]}},
      {projection:{name:1,integrationProvider:1},maxTimeMS:2500}).limit(2).toArray();
    if(shops.length!==1||shops[0].name!=="Telle Tire - 101"||shops[0].integrationProvider!=="protractor")throw Error("shop_changed");
    const inventory=await collectRecoveryInventory(refs,captures,(source,after)=>sourceRows(pg,db,source,after));
    await writeFile(output,JSON.stringify(inventory),{mode:0o600,flag:"wx"});
    console.log(JSON.stringify({complete:true,matchedCopies:inventory.records.length,sourceWrites:0,providerRequests:0}));
  }finally{await Promise.all([pg.end(),mongo.close()]);}
}
main().catch(e=>{
  console.error(JSON.stringify({failed:true,reason:e instanceof Error&&/^[a-z_]+$/.test(e.message)?e.message:"inventory_failed"}));
  process.exitCode=1;
});
