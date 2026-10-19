/** Offline proposal/simulation only. No source clients or write executor. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {previewStoredEvidence,type StoredEvidenceCase} from "./invoice-evidence-local-preview";

function canonical(value:any):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.keys(value).sort()
    .filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const evidenceDigest=(value:any)=>createHash("sha256").update(canonical(value)).digest("hex");
export interface SnapshotTarget {
  id:string;shop_id:number;status:string;soft_delete:any;provenance:any;custom_fields:any;
}
export function prepareInvoiceMetadataProposal(record:StoredEvidenceCase,targets:SnapshotTarget[]){
  assert.equal(targets.length,1,"Exactly one target owner is required");
  const target=targets[0];
  assert.equal(target.shop_id,record.shopId,"Target shop mismatch");
  assert.equal(target.provenance?.sourceSystem,"protractor");
  const ids=[...new Set((target.provenance?.sourceIds??[])
    .filter((s:any)=>s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType))
    .map((s:any)=>String(s.idValue).toLowerCase()))];
  assert.equal(ids.length,1,"Ambiguous target aliases");
  assert.equal(ids[0],record.sourceIds[0]?.toLowerCase());
  assert.equal(target.status,"closed");
  assert.ok(!target.soft_delete?.isDeleted,"Deleted target");
  assert.ok(target.custom_fields&&typeof target.custom_fields==="object"&&!Array.isArray(target.custom_fields));
  assert.ok(target.custom_fields.invoiceHours==null,"Existing evidence must not be overwritten");
  const result=previewStoredEvidence(record);
  assert.equal(result.category,"complete_candidate","Incomplete/conflicting source");
  assert.ok(result.evidence);
  return {
    shopId:record.shopId,provider:"protractor" as const,sourceId:result.evidence.id,
    snapshotTargetHash:target.id,
    expectedSnapshotDigest:evidenceDigest(target),
    expectedInvoiceField:Object.hasOwn(target.custom_fields,"invoiceHours")?"null" as const:"absent" as const,
    sourceCopyDigests:record.copies.map(c=>evidenceDigest(c)),
    sourceCaseDigest:evidenceDigest(record),
    patch:{path:"custom_fields.invoiceHours" as const,value:result.evidence},
    repairAuthorized:false as const,
    livePreflightRequired:true as const,
  };
}
export function simulateInvoiceMetadataProposal(
  proposal:ReturnType<typeof prepareInvoiceMetadataProposal>,record:StoredEvidenceCase,target:SnapshotTarget,
){
  assert.equal(evidenceDigest(proposal),evidenceDigest(prepareInvoiceMetadataProposal(record,[target])),
    "Source, proposal or target changed");
  // Only a cloned local value changes; unrelated metadata and target fields
  // remain byte-equivalent under canonical serialization.
  return {...structuredClone(target),custom_fields:{
    ...structuredClone(target.custom_fields),invoiceHours:structuredClone(proposal.patch.value),
  }};
}
