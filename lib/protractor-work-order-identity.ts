/** Display numbers are not provider identity. Never union distinct invoices. */
export class ProtractorIdentityConflict extends Error {
  readonly code = "PROTRACTOR_IDENTITY_CONFLICT";
  constructor() { super("Protractor work-order identity conflict; stored records require review."); }
}
export function protractorWorkOrderIdentity(provenance:any):string {
  if(!Array.isArray(provenance?.sourceIds))throw new ProtractorIdentityConflict();
  const ids=new Set<string>((provenance?.sourceIds??[])
    .filter((s:any)=>s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType))
    .map((s:any)=>String(s.idValue??"").toLowerCase()));
  if(ids.size!==1)throw new ProtractorIdentityConflict();
  const id=[...ids][0];
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))throw new ProtractorIdentityConflict();
  return id;
}
export function assertSameProtractorWorkOrder(existing:any,incoming:any):void {
  if((existing?.sourceSystem!=null&&existing.sourceSystem!=="protractor")||
    protractorWorkOrderIdentity(existing)!==protractorWorkOrderIdentity(incoming))
    throw new ProtractorIdentityConflict();
}

/** Compare identity fields only: PG and Mongo serialize provenance dates differently. */
export function protractorMongoIdentityFilter(existing:any,incoming:any) {
  assertSameProtractorWorkOrder(existing,incoming);
  const id=protractorWorkOrderIdentity(incoming);
  const values=[...new Set([id,id.toUpperCase(),...[existing,incoming].flatMap(p=>
    (p.sourceIds??[]).filter((s:any)=>s.system==="protractor"&&
      ["invoice_id","work_order_id"].includes(s.idType)).map((s:any)=>String(s.idValue)))])];
  const base={system:"protractor",idType:{$in:["invoice_id","work_order_id"]}};
  return {
    $or:[{"provenance.sourceSystem":"protractor"},{"provenance.sourceSystem":null}],
    "provenance.sourceIds":{$elemMatch:{...base,idValue:{$in:values}}},
    $nor:[{"provenance.sourceIds":{$elemMatch:{...base,idValue:{$nin:values}}}}],
  };
}
