import {type Capture,type Inventory,type Retained,TELLE_REFERENCE_HASH,validateReferences,evidenceHash} from "./telle-recovery-review";
import {sources,type RawRow} from "./telle-retained-reader";
/** Reads all nine retained-source families through a bounded, supplied reader.
 * Failure, missing table, duplicate cursor or cap exhaustion never means absence. */
export async function collectRecoveryInventory(input:unknown,captures:Capture[],
 read:(source:typeof sources[number],after:string)=>Promise<RawRow[]>,now=Date.now){
  const refs=validateReferences(input),ids=new Set(captures.map(c=>c.providerId.toLowerCase()));
  const records:(Retained&{source:string;cursor:string})[]=[],scanned:Record<string,number>={};
  const deadline=now()+120000;
  for(const source of sources){
    let after="",count=0;const visited=new Set<string>();
    while(true){
      if(now()>=deadline)throw Error("inventory_deadline");
      const page=await read(source,after);
      if(!Array.isArray(page)||page.length>50)throw Error("inventory_page_invalid");
      if(!page.length)break;
      count+=page.length;if(count>25000)throw Error("inventory_budget");
      for(const r of page){
        if(!r.cursor||visited.has(r.cursor))throw Error("inventory_cursor_repeated");
        visited.add(r.cursor);
        if(r.oversized)throw Error("inventory_oversized_unknown");
        const p=r.raw;
        // Missing raw evidence can hide a matching reference. Do not certify absence.
        if(!p)throw Error("inventory_raw_missing");
        const id=String(p.ID??"").toLowerCase(),invoice=String(p.InvoiceNumber??""),wo=String(p.WorkOrderNumber??"");
        if(!ids.has(id)&&!refs.some(x=>x.invoiceNumber===invoice||x.workOrderNumber===wo))continue;
        if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)||
          typeof p.Header?.LastModifiedTime!=="string"||
          !/(Z|[+-]\d\d:\d\d)$/.test(p.Header.LastModifiedTime)||!Number.isFinite(Date.parse(p.Header.LastModifiedTime)))
          throw Error("inventory_identity_or_version_missing");
        const valid=r.provenance?r.provenance.sourceSystem==="protractor"&&r.provenance.sourceIds?.some((s:any)=>
          s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType)&&String(s.idValue).toLowerCase()===id):
          String(r.identity).toLowerCase()===id;
        if(!valid)throw Error("inventory_provenance_mismatch");
        records.push({providerId:id,invoiceNumber:invoice,workOrderNumber:wo,version:p.Header.LastModifiedTime,
          bodyHash:evidenceHash(p),source,cursor:r.cursor});
        if(records.length>1000)throw Error("inventory_match_budget");
      }
      after=page.at(-1)!.cursor;
    }
    scanned[source]=count;
  }
  return {shopId:282,referenceHash:TELLE_REFERENCE_HASH,capturedAt:new Date(now()).toISOString(),
    complete:true,records,scanned} satisfies Inventory&{scanned:Record<string,number>};
}
