import { invoiceHoursEvidence, type InvoiceEvidence } from "../lib/invoice-hours-contract";
import { protractorInvoiceLaborEvidence } from "../lib/integrations/protractor/labor-evidence";

export const sameEvidence = (a:any,b:any) => a===b || (!!a&&!!b&&
  ["version","id","date","sold","presented"].every(k=>a[k]===b[k]));

/** Read-only reconciliation: snapshots can veto, never invent an invoice. */
export function reconcileStored(ids:string[], payloads:any[], archive:(InvoiceEvidence|null)[]) {
  const raws=payloads.filter(Boolean);
  const candidates=[...archive,...raws.map(invoiceHoursEvidence).filter(Boolean)] as (InvoiceEvidence|null)[];
  if(!ids.length)return {reason:"missing_provider_identity",evidence:null};
  if(!candidates.length) {
    const reason=!raws.length?"no_matched_payload":
      raws.every(r=>!(Number(r.InvoiceNumber)>0))?"missing_positive_invoice_number":
      "invalid_invoice_identity_date_or_finality";
    return {reason,evidence:null};
  }
  const e=candidates[0];
  if(!e||!ids.includes(e.id)||candidates.some(x=>!sameEvidence(x,e)))
    return {reason:"conflicting_evidence",evidence:null};
  for(const raw of raws) {
    if(raw.ID&&String(raw.ID).toLowerCase()!==e.id)
      return {reason:"conflicting_identity",evidence:null};
    if(raw.InvoiceTime) {
      const text=String(raw.InvoiceTime);
      const stamp=Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(text)?text:text+"Z");
      if(!Number.isFinite(stamp)||new Date(stamp).toISOString()!==e.date)
        return {reason:"conflicting_date",evidence:null};
    }
    const old=protractorInvoiceLaborEvidence(raw);
    if(old&&(["sold","presented"] as const).some(k=>old[k]!==null&&e[k]!==null&&old[k]!==e[k]))
      return {reason:"conflicting_recorded_hours",evidence:null};
  }
  return {reason:e.sold===null||e.presented===null?"verified_incomplete_hours":"verified_complete",evidence:e};
}
