/** Bounded read-only source reader; independent of export/delivery code. */
import type {Db} from "mongodb";
import {ObjectId} from "mongodb";
import type postgres from "postgres";
export const sources=["pg.normalized_work_orders","pg.protractor_work_orders","pg.protractor_invoices",
  "pg.protractor_invoice_cache","mongo.protractor_work_orders","mongo.protractor_invoices",
  "mongo.protractor_invoice_cache","mongo.normalized_string","mongo.normalized_object"] as const;
export interface RawRow {cursor:string;raw:any;identity?:unknown;provenance?:any;oversized?:boolean}
export async function sourceRows(pg:postgres.Sql,db:Db,source:typeof sources[number],after:string):Promise<RawRow[]>{
  const normalized=source.includes("normalized");
  if(source.startsWith("pg.")){
    const table=source.slice(3);
    const key=normalized?"id":table==="protractor_work_orders"?"work_order_id":"invoice_id";
    const raw=normalized?`raw_data->'rawPayload'`:table==="protractor_invoice_cache"?`payload->'invoice'`:
      `COALESCE(payload->'rawPayload',payload->'data')`;
    const rows=await pg.unsafe(`SELECT ${key}::text AS cursor,
      ${normalized?"provenance":`${key} AS identity`},
      CASE WHEN octet_length((${raw})::text)<=524288 THEN ${raw} ELSE NULL END AS raw,
      octet_length((${raw})::text)>524288 AS oversized
      FROM ${table} WHERE shop_id=282 AND ${key}::text COLLATE "C">$1
      ${normalized?`AND provenance->>'sourceSystem'='protractor'`:""}
      ORDER BY ${key}::text COLLATE "C" LIMIT 50`,[after]);
    return rows as unknown as RawRow[];
  }
  const table=normalized?"normalized_work_orders":source.slice(6),key=normalized?"_id":table==="protractor_work_orders"?"workOrderId":"invoiceId";
  const type=source.endsWith("_object")?"objectId":"string";
  const raw=normalized?"$rawPayload":table==="protractor_invoice_cache"?"$invoice":{$ifNull:["$rawPayload","$data"]};
  const rows=await db.collection(table).aggregate([
    {$match:{shopId:{$in:[282,"282"]},...(normalized?{"provenance.sourceSystem":"protractor"}:{}),
      [key]:{...(normalized?{$type:type}:{}),...(after?{$gt:type==="objectId"?new ObjectId(after):after}:{})}}},
    {$sort:{[key]:1}},{$limit:50},
    {$project:{cursor:`$${key}`,identity:normalized?undefined:`$${key}`,provenance:normalized?1:undefined,
      raw:{$cond:[{$lte:[{$bsonSize:"$$ROOT"},524288]},raw,null]},
      oversized:{$gt:[{$bsonSize:"$$ROOT"},524288]}}},
  ].map(stage=>{
    if("$project" in stage)stage.$project=Object.fromEntries(Object.entries(stage.$project!).filter(([,v])=>v!==undefined)) as any;
    return stage;
  }),{maxTimeMS:3000,allowDiskUse:false}).toArray();
  return rows.map(r=>({...r,cursor:String(r.cursor)})) as RawRow[];
}
