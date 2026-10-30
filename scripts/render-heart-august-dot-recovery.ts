/** Offline publication from immutable local detail checkpoints. Never contacts a DB or provider. */
import { readFile, writeFile } from "node:fs/promises";
import { emptyTireResult, validateTireDefinition, extractTireInvoice, tireCoverageGap, tireCsv } from "../lib/tire-dot-report";
const dir="generated-artifacts/heart-tire-dot-validation/2026-08-01_2026-08-31/detail-recovery";
async function main(){
 const plan=JSON.parse(await readFile(`${dir}/plan.json`,"utf8"));
 const shops=[...new Set<number>(plan.candidates.map((c:any)=>c.shopId))];
 const locations=shops.map(shopId=>({shopId,name:plan.candidates.find((c:any)=>c.shopId===shopId).location}));
 const result=emptyTireResult(validateTireDefinition({dateRange:{start:"2026-08-01",end:"2026-08-31"},locationIds:shops}),locations);
 tireCoverageGap(result,"Read-only detail recovery of CSV-anchored candidates only, not certified full population. Export dates are CDT; report uses inclusive UTC days. No production records were updated.");
 const outcomes:any[]=[];
 for(const c of plan.candidates){
  let saved:any;
  try{saved=JSON.parse(await readFile(`${dir}/${c.shopId}-${c.roId}.json`,"utf8"));}catch(e:any){
   if(e.code!=="ENOENT")throw e;
   outcomes.push({...c,status:"not_recovered"});tireCoverageGap(result,"Some planned invoices have no completed recovery checkpoint.");continue;
  }
  if(saved.shopId!==c.shopId||saved.roId!==c.roId||saved.invoice!==c.invoice||String(saved.data.id)!==c.roId||
    saved.data.shopId!==c.providerShopId||String(saved.data.repairOrderNumber)!==c.invoice)throw new Error("Checkpoint identity mismatch");
  extractTireInvoice(result,c.shopId,{workOrderId:c.roId,data:saved.data});
  const invoice=result.invoices.find(i=>i.key===`${c.shopId}:${c.roId}`);
  if(saved.financialDifferences?.length){
   tireCoverageGap(result,"Some recovered current financial fields differ from the historical export.");
   const message=`Financial fields differ from export: ${saved.financialDifferences.join("; ")}`;
   if(invoice)invoice.exceptions.push(message);
   result.details.filter(d=>d.key.startsWith(`${c.shopId}:${c.roId}:`)).forEach(d=>d.exceptions.push(message));
  }
  outcomes.push({...c,status:invoice?"included_tire_invoice":"recovered_not_included",fetchedAt:saved.fetchedAt,financialDifferences:saved.financialDifferences,
   rawDotEntries:saved.data.jobs.reduce((n:number,j:any)=>n+j.parts.reduce((sum:number,p:any)=>sum+(Array.isArray(p.dotNumbers)?p.dotNumbers.length:0),0),0)});
 }
 result.generatedAt=new Date().toISOString();
 await writeFile(`${dir}/final-result.json`,JSON.stringify(result,null,2),{mode:0o600});
 await writeFile(`${dir}/final-outcomes.json`,JSON.stringify(outcomes,null,2),{mode:0o600});
 for(const view of ["details","invoices"] as const)await writeFile(`${dir}/august-tire-${view}.csv`,tireCsv(result,view),{mode:0o600});
 const summary=locations.map(l=>({location:l.name,planned:outcomes.filter(o=>o.shopId===l.shopId).length,
  recovered:outcomes.filter(o=>o.shopId===l.shopId&&o.status!=="not_recovered").length,invoices:result.invoices.filter(i=>i.shopId===l.shopId).length,
  withDots:result.invoices.filter(i=>i.shopId===l.shopId&&i.dotEntries>0).length,dotEntries:result.invoices.filter(i=>i.shopId===l.shopId).reduce((n,i)=>n+i.dotEntries,0)}));
 await writeFile(`${dir}/summary.json`,JSON.stringify({generatedAt:result.generatedAt,counts:result.counts,locations:summary,coverage:result.coverage},null,2),{mode:0o600});
 console.log(JSON.stringify({counts:result.counts,locations:summary,notRecovered:outcomes.filter(o=>o.status==="not_recovered").length}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
