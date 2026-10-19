/** Offline explanation of a bounded real-source capture, never a repair plan. */
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
const input=readFileSync(process.argv[2]??"/tmp/invoice-owner-financial-evidence.json","utf8");
const evidence=JSON.parse(input);
assert.equal(evidence.version,1);
assert.equal(evidence.children.length,329);assert.equal(evidence.owners.length,36);
assert.equal(new Set(evidence.children.map((c:any)=>`${c.table}:${c.id}`)).size,329);
assert.equal(new Set(evidence.owners.map((o:any)=>o.owner)).size,36);
assert.ok(evidence.children.every((c:any)=>evidence.owners.some((o:any)=>o.owner===c.owner)));
const unique=(xs:any[])=>[...new Set(xs)];
const zero=(v:any)=>v!==null&&Number(v)===0;
function explain(c:any,f:string){
  const source=unique(c.matches.map((m:any)=>m.values[f]));
  if(source.length>1)return source.filter(v=>v!==null).length>1?"retained_numeric_conflict":"retained_missingness_conflict";
  const v=source[0],s=c.stored[f];
  if(s===v)return "equal";
  if((s===null&&zero(v))||(v===null&&zero(s)))return "null_vs_explicit_zero";
  if(c.table==="normalized_service_jobs")return f==="laborHoursBilled"
    ?"derived_line_hours_missing_in_store":"package_rollup_vs_stored_value";
  if(f==="laborHours"&&c.matches.every((m:any)=>Number(m.native.Quantity)===0))
    return "zero_quantity_defaulted_to_one_not_proven_hours";
  if(f==="unitPrice"&&c.matches.every((m:any)=>Number(m.native.Price)===0&&Number(m.native.Quantity)===0))
    return "price_derived_using_default_quantity";
  if(f==="extendedPrice"&&c.matches.every((m:any)=>m.native.Total!=null&&m.native.ExtendedTotal!=null&&Number(m.native.Total)!==Number(m.native.ExtendedTotal)))
    return "native_total_vs_extended_total_semantics";
  if(f==="unitCost"&&c.matches.every((m:any)=>m.native.TotalCost!=null&&Number(m.native.Quantity)>0))
    return "native_extended_cost_divided_by_quantity_vs_store";
  if(s===null||v===null)return "missing_vs_known_value";
  return "unexplained_stored_numeric_difference";
}
const rows=evidence.children.map((c:any)=>{
  assert.ok(c.matches.length);
  const fields=Object.keys(c.stored).filter(f=>c.matches.some((m:any)=>m.values[f]!==c.stored[f]))
    .map(f=>({field:f,classification:explain(c,f),stored:c.stored[f],retained:unique(c.matches.map((m:any)=>m.values[f]))}));
  const vetoes=unique([
    ...(!c.sourceJobLink?["source_job_link_conflict"]:[]),
    ...(c.matches.some((m:any)=>m.owner!==c.owner)?["child_owner_conflict"]:[]),
    ...(!["verified","stored_value_mismatch","conflicting_child_values"].includes(c.reason)?[c.reason]:[]),
    ...fields.map(f=>f.classification),
  ]);
  return {table:c.table,id:c.id,owner:c.owner,legacyReason:c.reason,fields,vetoes,
    // All distinct conflicting copies, never a preferred or latest value.
    ...(c.reason!=="verified"?{proofs:[...new Map(c.matches.map((m:any)=>{
      const proof={digest:m.copy,values:m.values,native:m.native};
      return [JSON.stringify(proof),proof];
    })).values()]}:{})};
});
const owners=evidence.owners.map((o:any)=>{
  const children=rows.filter((c:any)=>c.owner===o.owner);
  const ownVetoes=unique([...(o.reason!=="verified_complete"?[o.reason]:[]),...children.flatMap((c:any)=>c.vetoes)]);
  // A split affects the old parent and its closure, not an independently writable owner.
  const group=evidence.owners.filter((p:any)=>p.parent===o.parent).map((p:any)=>p.owner);
  const siblingVeto=group.some((id:string)=>id!==o.owner&&(
    evidence.owners.find((p:any)=>p.owner===id).reason!=="verified_complete"||
    rows.some((c:any)=>c.owner===id&&c.vetoes.length)));
  return {...o,children:children.length,mismatches:children.filter((c:any)=>c.legacyReason==="stored_value_mismatch").length,
    conflicts:children.filter((c:any)=>c.legacyReason==="conflicting_child_values").length,
    ownEvidenceEligible:ownVetoes.length===0,
    repairEligible:false,
    vetoes:unique([...ownVetoes,...(siblingVeto?["shared_parent_has_vetoed_owner"]:[]),
      "separate_production_approval_and_fresh_atomicity_checks_required"])};
});
const counts:Record<string,number>={};
for(const c of rows)for(const f of c.fields)counts[f.classification]=(counts[f.classification]??0)+1;
const report={scope:"Bounded retained-source evidence only; no financial proposals or execution authorization",
  inputDigest:createHash("sha256").update(input).digest("hex"),snapshot:evidence.snapshot,cutoff:evidence.cutoff,
  productionWrites:0,providerRequests:0,fieldCounts:counts,owners,children:rows};
writeFileSync("docs/reporting/invoice-owner-financial-resolution.json",JSON.stringify(report,null,2)+"\n");
const abbreviations:Record<string,string>={
  conflicting_date:"D",missing_positive_invoice_number:"I",retained_numeric_conflict:"C",
  retained_missingness_conflict:"H",null_vs_explicit_zero:"N",missing_vs_known_value:"M",
  package_rollup_vs_stored_value:"R",derived_line_hours_missing_in_store:"H",
  native_extended_cost_divided_by_quantity_vs_store:"K",
  zero_quantity_defaulted_to_one_not_proven_hours:"Q",price_derived_using_default_quantity:"Q",
  native_total_vs_extended_total_semantics:"T",shared_parent_has_vetoed_owner:"S",
  separate_production_approval_and_fresh_atomicity_checks_required:"A",
};
writeFileSync("docs/reporting/invoice-owner-financial-eligibility.md",
  "# Per-owner eligibility — retained evidence\n\n"+
  "Generated by `scripts/resolve-invoice-owner-financial-evidence.ts`. See "+
  "[resolution rules and findings](invoice-owner-financial-resolution.md) for the legend and scope. "+
  "Every row is **HOLD**, not permission to repair. Full hashes, field values and copy digests are in "+
  "`invoice-owner-financial-resolution.json`.\n\n"+
  "| Shop | Owner hash prefix | Children | Stored mismatches | Copy conflicts | Vetoes |\n"+
  "| --- | --- | ---: | ---: | ---: | --- |\n"+
  owners.map((o:any)=>`| ${o.shop} | ${o.owner.slice(0,12)} | ${o.children} | ${o.mismatches} | ${o.conflicts} | ${unique(o.vetoes.map((v:string)=>abbreviations[v]??v)).join(", ")} |`).join("\n")+"\n");
console.log(JSON.stringify({counts,owners:owners.length,ownEvidenceEligible:owners.filter((o:any)=>o.ownEvidenceEligible).map((o:any)=>o.owner),
  repairEligible:owners.filter((o:any)=>o.repairEligible).length},null,2));
