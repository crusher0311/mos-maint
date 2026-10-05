/** Scoped recovery: no merge, deletion, or mutation of existing vehicles. */
export function resolveRecoveryVehicle(source:any, old:any, candidates:any[],
  approval:{replaceFromInvoice?:boolean;unknownVehicle?:boolean}={}) {
  const si=source.ServiceItem;
  const vin=String(si?.VIN||si?.Lookup||"").trim().toUpperCase();
  const validVin=/^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
  if(approval.unknownVehicle) {
    if(validVin || old) throw new Error("unknown-vehicle approval no longer matches");
    return {vehicle:undefined,vin:"",unlinked:true};
  }
  const active=(v:any)=>!v.soft_delete?.isDeleted;
  const key=(v:any)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  const previous=candidates.find(v=>v.id===old?.vehicle_id);
  const sameProviderVehicle=!!si?.ID &&
    old?.raw_data?.rawPayload?.ServiceItem?.ID===si.ID;
  const sameDetails=previous && Number(previous.year)===Number(si.Year) &&
    key(previous.make)===key(si.Make) && key(previous.model)===key(si.Model);
  const priorConfirmed=previous && active(previous) && sameProviderVehicle && sameDetails &&
    (!previous.vin || (validVin && String(previous.vin).toUpperCase()===vin));
  const exact=validVin?candidates.filter(v=>String(v.vin??"").toUpperCase()===vin):[];
  if(exact.length>1 || exact.some(v=>!active(v)))
    throw new Error("ambiguous vehicle");
  if(exact.length===1) {
    if(previous && previous.id!==exact[0].id && !priorConfirmed && !approval.replaceFromInvoice)
      throw new Error("ambiguous vehicle");
    return {vehicle:exact[0],vin};
  }
  if(priorConfirmed) return {vehicle:previous,vin};
  if(previous && !approval.replaceFromInvoice) throw new Error("ambiguous vehicle");
  if(!validVin) throw new Error("unusable vehicle identity");
  return {vehicle:undefined,vin};
}
