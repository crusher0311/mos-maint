/**
 * Disposable PostgreSQL prototype. Never imports app DB clients or credentials.
 * Clearance is a fixture input, NOT a production authority or repair permission.
 */
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {previewStoredEvidence} from "../invoice-evidence-local-preview";

export type Entry = {
  shopId: number; sourceIds: string[];
  copies: {shopId: number; ref: string; raw: unknown}[];
  clearance: "reviewed" | "held" | "unknown";
};
export type Manifest = {shopId:number; inventoryComplete:boolean; entries:Entry[]};
export const digest = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const version="stored-evidence-prototype-1";
function validate(m:Manifest) {
  assert.ok(Number.isSafeInteger(m.shopId)&&m.shopId>0);
  assert.ok(m.entries.length<=100000);
  const ids=new Set<string>();
  for (const e of m.entries) {
    assert.equal(e.shopId,m.shopId);
    assert.equal(e.sourceIds.length,1);
    const id=e.sourceIds[0].toLowerCase();
    assert.match(id,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.ok(!ids.has(id),"Duplicate invoice identity");ids.add(id);
    assert.ok(["reviewed","held","unknown"].includes(e.clearance));
    assert.ok(e.copies.length<=100);
    assert.equal(new Set(e.copies.map(c=>c.ref)).size,e.copies.length);
    assert.ok(e.copies.every(c=>c.shopId===m.shopId&&c.ref.length>0));
  }
}
async function disposable(sql:any) {
  const [r]=await sql`SELECT current_setting('invoice_preview.disposable',true) AS marker`;
  assert.equal(r.marker,"yes","Local disposable database required");
}
export async function beginBuild(sql:any,m:Manifest) {
  await disposable(sql); validate(m);
  const id=randomUUID();
  await sql`INSERT INTO invoice_projection.builds(id,shop_id,manifest_digest,parser_version,expected_count)
    VALUES(${id},${m.shopId},${digest(m)},${version},${m.entries.length})`;
  return id;
}
export async function appendBatch(sql:any,id:string,m:Manifest,offset:number,size=25) {
  await disposable(sql);validate(m);
  assert.ok(Number.isSafeInteger(size)&&size>0&&size<=100);
  assert.ok(Number.isSafeInteger(offset)&&offset>=0&&offset<m.entries.length);
  return sql.begin(async(tx:any)=>{
    const [b]=await tx`SELECT * FROM invoice_projection.builds WHERE id=${id} FOR UPDATE`;
    assert.ok(b&&b.state==="building");
    assert.equal(b.manifest_digest,digest(m),"Source manifest changed; start a new generation");
    assert.equal(b.parser_version,version);
    const end=Math.min(offset+size,m.entries.length);
    if(offset<b.checkpoint) {
      assert.ok(end<=b.checkpoint,"Replay overlaps uncommitted work");
      return Number(b.checkpoint);
    }
    assert.equal(offset,b.checkpoint,"Non-contiguous batch");
    for(let i=offset;i<end;i++){
      const e=m.entries[i],providerId=e.sourceIds[0].toLowerCase();
      const result=previewStoredEvidence(e);
      const verified=e.clearance==="reviewed"&&result.evidence!==null;
      const evidence=verified?result.evidence:null;
      const reason=e.clearance==="reviewed"?result.reason:`clearance_${e.clearance}`;
      await tx`INSERT INTO invoice_projection.facts
        (build_id,ordinal,provider_id,input_digest,classification,reason,invoice_date,sold,presented)
        VALUES(${id},${i},${providerId},${digest(e)},${verified?"verified":"unresolved"},${reason},
        ${evidence?.date??null},${evidence?.sold??null},${evidence?.presented??null})`;
      for(const c of e.copies) await tx`INSERT INTO invoice_projection.evidence
        (build_id,provider_id,source_ref,source_digest)
        VALUES(${id},${providerId},${c.ref},${digest(c.raw)})`;
    }
    await tx`UPDATE invoice_projection.builds SET checkpoint=${end} WHERE id=${id}`;
    return end;
  });
}
export async function publishBuild(sql:any,id:string,m:Manifest) {
  await disposable(sql);validate(m);assert.equal(m.inventoryComplete,true,"Incomplete inventory");
  await sql.begin(async(tx:any)=>{
    // Serialize same-shop publication before taking row locks.
    await tx`SELECT pg_advisory_xact_lock(73214,${m.shopId})`;
    const [b]=await tx`SELECT * FROM invoice_projection.builds WHERE id=${id} FOR UPDATE`;
    assert.ok(b&&b.state==="building");assert.equal(b.manifest_digest,digest(m));
    assert.equal(b.parser_version,version);assert.equal(b.checkpoint,m.entries.length);
    const [count]=await tx`SELECT count(*)::integer AS n FROM invoice_projection.facts WHERE build_id=${id}`;
    assert.equal(count.n,m.entries.length);
    const [newer]=await tx`SELECT id FROM invoice_projection.builds
      WHERE shop_id=${m.shopId} AND published AND created_at>${b.created_at} LIMIT 1`;
    assert.ok(!newer,"Cannot replace a newer published generation");
    await tx`UPDATE invoice_projection.builds SET published=false WHERE shop_id=${m.shopId} AND published`;
    await tx`UPDATE invoice_projection.builds SET state='complete',published=true,completed_at=now() WHERE id=${id}`;
  });
}
export async function report(sql:any,authorizedShops:number[],shopId:number,start:string,end:string):Promise<any> {
  await disposable(sql);assert.ok(authorizedShops.includes(shopId),"Unauthorized shop");
  assert.ok(Number.isFinite(Date.parse(start))&&Date.parse(start)<Date.parse(end));
  // One statement: generation pointer and facts share the same database snapshot.
  const [row]=await sql`
    SELECT b.id,b.completed_at,
      count(f.provider_id) FILTER(WHERE f.classification='unresolved')::integer AS unresolved,
      count(f.provider_id) FILTER(WHERE f.classification='verified' AND f.invoice_date>=${start}::timestamptz
        AND f.invoice_date<${end}::timestamptz)::integer AS invoices,
      count(f.provider_id) FILTER(WHERE f.classification='verified' AND f.invoice_date>=${start}::timestamptz
        AND f.invoice_date<${end}::timestamptz AND f.sold IS NOT NULL AND f.presented IS NOT NULL)::integer AS covered,
      sum(f.sold) FILTER(WHERE f.invoice_date>=${start}::timestamptz AND f.invoice_date<${end}::timestamptz) AS sold,
      sum(f.presented) FILTER(WHERE f.invoice_date>=${start}::timestamptz AND f.invoice_date<${end}::timestamptz) AS presented
    FROM invoice_projection.builds b LEFT JOIN invoice_projection.facts f ON f.build_id=b.id
    WHERE b.shop_id=${shopId} AND b.published AND b.state='complete'
    GROUP BY b.id`;
  if(!row)return {status:"not_built",averageSold:null,averagePresented:null};
  const complete=row.unresolved===0&&row.covered===row.invoices;
  return {...row,status:complete?"complete":"incomplete",averageSold:complete&&row.invoices?Number(row.sold)/row.invoices:null,
    averagePresented:complete&&row.invoices?Number(row.presented)/row.invoices:null};
}
