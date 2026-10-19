/**
 * Entirely synthetic, minimal source-shaped records; not redacted production exports.
 * No names, addresses, VINs, account IDs, credentials or customer payloads.
 */
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const job=(key:string,hours:number)=>({
  ID:key,Status:"Completed",IsInvoicing:true,
  ServicePackageLines:{ItemCollection:[{ID:`${key}-line`,Type:"Labor",Quantity:hours,Unit:"Hours"}]},
});
const invoice=(n:number,sold:number,deferred=0,date="2026-09-20T12:00:00Z")=>({
  ID:id(n),Type:"WorkOrder",WorkflowStage:"Invoice",InvoiceNumber:n,
  WorkOrderNumber:String(n),InvoiceTime:date,
  ServicePackages:{ItemCollection:[job(`job-${n}`,sold)]},
  DeferredServicePackages:{ItemCollection:deferred?[job(`deferred-${n}`,deferred)]:[]},
});

export function ownerFixture() {
  const owners=[
    {id:id(1),shop:1,payloads:[invoice(1,2,3)],deleted:false,reason:"verified_complete"},
    {id:id(2),shop:1,payloads:[invoice(2,7,1)],deleted:false,reason:"verified_complete"},
    {id:id(3),shop:1,payloads:[{...invoice(3,91),InvoiceNumber:0}],deleted:false,reason:"missing_positive_invoice_number"},
    {id:id(4),shop:1,payloads:[invoice(4,92),invoice(4,93)],deleted:false,reason:"conflicting_evidence"},
    {id:id(5),shop:1,payloads:[invoice(5,94,5)],deleted:true,reason:"verified_complete"},
    {id:id(6),shop:1,payloads:[invoice(6,11,2,"2025-01-01T12:00:00Z")],deleted:false,reason:"verified_complete"},
    // Same work-order number in a different shop is legitimate.
    {id:id(7),shop:2,payloads:[{...invoice(7,13,4),WorkOrderNumber:"1"}],deleted:false,reason:"verified_complete"},
    {id:id(8),shop:1,payloads:[invoice(8,17,2,"2027-01-01T12:00:00Z")],deleted:false,reason:"verified_complete"},
  ];
  const nodes=owners.filter(o=>o.id!==id(2)).map(o=>({
    record:o.id===id(1)?"mixed":`parent-${o.id}`,shop:o.shop,
    sourceIds:o.id===id(1)?[id(1),id(2)]:[o.id],
    desired:(o.id===id(1)?[owners[0],owners[1]]:[o]).map(x=>({
      owner:x.id,numbers:[x.payloads[0].WorkOrderNumber],
    })),
  }));
  const children=owners.flatMap((o,i)=>{
    const parent=nodes.find(n=>n.sourceIds.includes(o.id))!.record;
    const base={parent,shop:o.shop,owner:o.id,immutableHash:String(i+1).repeat(64)};
    return [
      {...base,table:"normalized_service_jobs",id:`job-${i}`,job:null},
      {...base,table:"normalized_line_items",id:`line-${i}`,job:`job-${i}`},
      {...base,table:"normalized_payments",id:`payment-${i}`,job:null},
    ];
  });
  return {owners,snapshot:{issues:[] as string[],nodes,children}};
}
