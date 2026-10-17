/** Read-only source inventory. Never imports a Protractor client or repairs data. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {writeFileSync} from "node:fs";
import {userInfo} from "node:os";
import postgres from "postgres";
import {getDb} from "../lib/mongo";
import {WEEKEND,weekendFrom} from "../lib/protractor-weekend-policy";

const port=Number(process.argv[2]);
assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
const pg=postgres({host:"127.0.0.1",port,database:"postgres",username:userInfo().username,max:1});
const guid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const dayOf=(value:unknown)=>{
  if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))return null;
  const day=value.slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day)return null;
  return day;
};
async function main(){
  assert.equal((await pg`SELECT current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
  const db=await getDb();
  const enterprise=await db.collection("enterprise_accounts").findOne({shopIds:227},{projection:{name:1,shopIds:1},maxTimeMS:5000});
  const shops=[227,228,229,230,231,232,233,234,235,236];
  assert.equal(enterprise?.name,"JWT");
  assert.deepEqual([...enterprise!.shopIds].map(Number).sort((a,b)=>a-b),shops);
  const groups=new Map<string,{shopId:number;day:string;targets:{rowId:string;ids:string[]}[];withinExistingGrant:boolean}>();
  const held:{shopId:number;rowId:string;reason:string}[]=[];
  let targets=0,cacheMatched=0;
  for(const shop of shops){
    const rows=await pg`SELECT w.id,w.provenance FROM normalized_work_orders w
      LEFT JOIN proposed_evidence p ON p.id=w.id WHERE w.shop_id=${shop}
      AND w.status='closed' AND p.id IS NULL
      AND (w.custom_fields->'invoiceHours' IS NULL OR w.custom_fields->'invoiceHours'='null'::jsonb)
      ORDER BY w.id`;
    assert.ok(rows.length<=50000);
    for(let offset=0;offset<rows.length;offset+=100){
      const batch=rows.slice(offset,offset+100).map(r=>({
        rowId:r.id,ids:[...new Set<string>((r.provenance?.sourceIds??[])
          .filter((s:any)=>s.system==="protractor"&&["work_order_id","invoice_id"].includes(s.idType)&&guid.test(s.idValue))
          .map((s:any)=>String(s.idValue)))]}));
      const ids=[...new Set(batch.flatMap(r=>r.ids.flatMap(id=>[id,id.toUpperCase(),id.toLowerCase()])))];
      // Unmatched mixed-case keys remain held; never infer absence from this lookup.
      const docs=ids.length?await db.collection("protractor_work_orders").find(
        {shopId:shop,workOrderId:{$in:ids}},
        {projection:{workOrderId:1,"rawPayload.InvoiceTime":1},maxTimeMS:5000}
      ).hint("protractor_wo_shop_work_order").limit(301).toArray():[];
      assert.ok(docs.length<=300,"Cache match cap reached");
      for(const row of batch){
        targets++;
        const matches=docs.filter(d=>row.ids.some(id=>id.toLowerCase()===String(d.workOrderId).toLowerCase()));
        if(matches.length)cacheMatched++;
        const dates=new Set(matches.map(d=>dayOf(d.rawPayload?.InvoiceTime)).filter(Boolean));
        if(!row.ids.length||dates.size!==1||matches.some(d=>!dayOf(d.rawPayload?.InvoiceTime))){
          held.push({shopId:shop,rowId:row.rowId,reason:!row.ids.length?"missing_identity":!matches.length?"no_cache_match":dates.size>1?"conflicting_dates":"missing_date"});
          continue;
        }
        const day=[...dates][0]!,key=`${shop}:${day}`;
        const group=groups.get(key)??{shopId:shop,day,targets:[],withinExistingGrant:day>=weekendFrom(shop)&&day<WEEKEND.until};
        group.targets.push(row);groups.set(key,group);
      }
      await new Promise(r=>setTimeout(r,100));
    }
    console.log(JSON.stringify({event:"source_inventory_shop",shop,unresolved:rows.length}));
  }
  const pages=[...groups.values()].sort((a,b)=>b.day.localeCompare(a.day)||a.shopId-b.shopId);
  const contents={version:1,kind:"invoice-evidence-source-plan",requestCap:1000,retriesConsumeBudget:true,
    providerRequests:0,productionReportingWrites:0,shops,groups:pages,held,
    dateWarning:"Cached dates are fetch-planning hints only, not verified reporting evidence.",
    dispatchApproved:false,blockedBy:"Dedicated capped background permission required; never borrow the active weekend grant."};
  const output="/tmp/jwt-invoice-source-recovery-plan.json";
  writeFileSync(output,JSON.stringify(contents),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({event:"source_inventory_complete",targets,cacheMatched,
    grouped:pages.reduce((n,p)=>n+p.targets.length,0),held:held.length,dateGroups:pages.length,
    outsideExistingGrant:pages.filter(p=>!p.withinExistingGrant).reduce((n,p)=>n+p.targets.length,0),
    minimumPageReads:pages.length,requestCap:1000,providerRequests:0,
    digest:createHash("sha256").update(JSON.stringify(contents)).digest("hex"),output}));
}
main().then(()=>pg.end()).then(()=>process.exit(0)).catch(async e=>{
  console.error(JSON.stringify({event:"source_inventory_failed",code:e?.code??"VALIDATION",type:e?.name}));
  await pg.end();process.exit(1);
});
