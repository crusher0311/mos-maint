import { invoiceHoursEvidence, type InvoiceEvidence } from "../lib/invoice-hours-contract";
import { protractorInvoiceLaborEvidence } from "../lib/integrations/protractor/labor-evidence";
import { reviewInvoiceChronology } from "./invoice-date-review";

export const sameEvidence = (a:any,b:any) => a===b || (!!a&&!!b&&
  ["version","id","date","sold","presented"].every(k=>a[k]===b[k]));

/** Read-only reconciliation: snapshots can veto, never invent an invoice. */
export function reconcileStored(ids:string[], payloads:any[], archive:(InvoiceEvidence|null)[],
  options?:{ignoreOlderSentinels:boolean;archiveHeaders:any[]}) {
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
  const chronological=options?.ignoreOlderSentinels
    ?reviewInvoiceChronology(ids,[...raws,...options.archiveHeaders]):null;
  const allowSentinels=chronological?.classification==="consistent_final_invoice_date"&&chronological.date===e.date;
  for(const raw of raws) {
    if(raw.ID&&String(raw.ID).toLowerCase()!==e.id)
      return {reason:"conflicting_identity",evidence:null};
    const olderSentinel=allowSentinels&&raw.WorkflowStage!=="Invoice"&&
      /^0001-01-01T00:00:00(?:\.0+)?$/.test(String(raw.InvoiceTime));
    if(raw.InvoiceTime&&!olderSentinel) {
      const text=String(raw.InvoiceTime);
      const stamp=Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(text)?text:text+"Z");
      if(!Number.isFinite(stamp)||new Date(stamp).toISOString()!==e.date)
        return {reason:"conflicting_date",evidence:null};
    }
    // The legacy helper ignores nonfinal snapshots. For the date-only
    // exception, inspect their recorded labor as a veto too. This projection
    // is never persisted or used to establish invoice identity or new hours.
    const old=protractorInvoiceLaborEvidence(olderSentinel
      ?{...raw,WorkflowStage:"Invoice",Status:undefined}:raw);
    if(old&&(["sold","presented"] as const).some(k=>old[k]!==null&&e[k]!==null&&old[k]!==e[k]))
      return {reason:"conflicting_recorded_hours",evidence:null};
  }
  return {reason:e.sold===null||e.presented===null?"verified_incomplete_hours":"verified_complete",evidence:e};
}
