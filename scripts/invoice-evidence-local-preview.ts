/** Offline only: no database/provider imports and no repair writes. */
import { reconcileStored, sameEvidence } from "./invoice-stored-evidence";
import type { InvoiceEvidence } from "../lib/invoice-hours-contract";

export interface StoredEvidenceCase {
  shopId: number;
  sourceIds: string[];
  copies: {shopId: number; raw: any}[];
  existingEvidence?: InvoiceEvidence | null;
}

/** A candidate is not repair authorization or financial corroboration. */
export function previewStoredEvidence(record: StoredEvidenceCase) {
  const held = (reason: string) => ({category:"held" as const,reason,evidence:null,repairAuthorized:false as const});
  if (!Number.isSafeInteger(record.shopId) || record.shopId <= 0 ||
      record.copies.some(copy => copy.shopId !== record.shopId)) return held("shop_scope_mismatch");
  const ids=[...new Set(record.sourceIds.map(id=>id.toLowerCase()))];
  if(ids.length!==1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ids[0]))
    return held("ambiguous_or_missing_identity");
  if(record.copies.some(copy=>!copy.raw ||
      String(copy.raw.ID??"").toLowerCase()!==ids[0])) return held("payload_identity_mismatch");
  const result=reconcileStored(ids,record.copies.map(copy=>copy.raw),[]);
  if(!result.evidence)return held(result.reason);
  if(record.existingEvidence) {
    if(!sameEvidence(record.existingEvidence,result.evidence))return held("existing_evidence_differs");
    return {category:"already_present" as const,reason:"unchanged",evidence:result.evidence,repairAuthorized:false as const};
  }
  return {
    category:result.reason==="verified_complete"?"complete_candidate" as const:"identity_date_only" as const,
    reason:result.reason,evidence:result.evidence,repairAuthorized:false as const,
  };
}
