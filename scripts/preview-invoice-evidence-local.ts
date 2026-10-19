/** Usage: node --import tsx scripts/preview-invoice-evidence-local.ts <local.json>
 * Input: StoredEvidenceCase[]. Output: counts/reasons only, never raw payloads.
 * No database clients, provider requests, credentials or repair writes.
 */
import {readFileSync,statSync} from "node:fs";
import assert from "node:assert/strict";
import {previewStoredEvidence,type StoredEvidenceCase} from "./invoice-evidence-local-preview";

try {
  const file=process.argv[2];
  assert.ok(file && process.argv.length===3);
  assert.ok(statSync(file).isFile() && statSync(file).size<=10*1024*1024,"Input exceeds 10 MB cap");
  const records=JSON.parse(readFileSync(file,"utf8")) as StoredEvidenceCase[];
  assert.ok(Array.isArray(records)&&records.length>0&&records.length<=1000);
  const shops=new Set(records.map(r=>r.shopId));
  assert.ok(shops.size<=10);
  const seen=new Set<string>();
  const counts:Record<string,number>={},reasons:Record<string,number>={};
  for(const record of records) {
    assert.ok(Array.isArray(record.sourceIds)&&Array.isArray(record.copies)&&record.copies.length<=20);
    assert.ok(record.sourceIds.every(id=>typeof id==="string"));
    const key=JSON.stringify([record.shopId,[...record.sourceIds].map(id=>id.toLowerCase()).sort()]);
    assert.ok(!seen.has(key),"Duplicate review identity");
    seen.add(key);
    const result=previewStoredEvidence(record);
    counts[result.category]=(counts[result.category]??0)+1;
    reasons[result.reason]=(reasons[result.reason]??0)+1;
  }
  console.log(JSON.stringify({scope:"supplied_local_cases_only",records:records.length,shops:shops.size,
    counts,reasons,productionWrites:0,providerRequests:0,repairAuthorized:false}));
} catch {
  console.error("Local preview rejected: require a valid bounded case file; no repair performed.");
  process.exitCode=1;
}
