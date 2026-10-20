import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { requireThat } from "@/lib/shop-dispatch/model";

export const GUIDED_RO_COLLECTION = "guided_ro_operations";
export type ConfirmedRO = {ok: true; workOrderId: string; workOrderNumber: number; packagesWithoutLines?: string[]};
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
/** Admission is persisted before native I/O. Existing admissions are NEVER replayed. */
export async function admitGuidedRO(db: Db, input: {
  id: string; shopId: number; actor: string; payload: unknown; recoveryOnly: boolean;
}) {
  const col = db.collection(GUIDED_RO_COLLECTION);
  const hash = createHash("sha256").update(JSON.stringify(canonical(input.payload))).digest("hex");
  const existing = await col.findOne({_id: input.id} as any, {maxTimeMS:5000});
  if (!existing && !input.recoveryOnly) {
    try {
      await col.insertOne({_id:input.id,shopId:input.shopId,actor:input.actor,digest:hash,
        state:"pending",createdAt:new Date()} as any,{writeConcern:{w:"majority",wtimeoutMS:5000}});
      return {admitted:true as const};
    } catch (error) {
      if ((error as {code?:number}).code !== 11000) throw error;
    }
  }
  const row = existing ?? await col.findOne({_id:input.id} as any,{maxTimeMS:5000});
  requireThat(row, "No saved creation request was found. Do not submit a new ticket until the original attempt is resolved.",409);
  requireThat(row.shopId === input.shopId && row.actor === input.actor && row.digest === hash,
    "Creation request is bound to different details; recover the original request.",409);
  return {admitted:false as const,result:row.state === "confirmed" ? row.result as ConfirmedRO : null};
}
export async function confirmGuidedRO(db: Db, id: string, result: any) {
  requireThat(result.ok === true && result.workOrderId?.toLowerCase() === id.toLowerCase() &&
    Number.isSafeInteger(Number(result.workOrderNumber)) && Number(result.workOrderNumber)>0,
    "Protractor creation has not returned a confirmed ticket identity",503);
  const receipt: ConfirmedRO = {ok:true,workOrderId:id,workOrderNumber:Number(result.workOrderNumber),
    ...(result.packagesWithoutLines?.length ? {packagesWithoutLines:result.packagesWithoutLines} : {})};
  await db.collection(GUIDED_RO_COLLECTION).updateOne({_id:id,state:"pending"} as any,
    {$set:{state:"confirmed",result:receipt,confirmedAt:new Date()}},{writeConcern:{w:"majority",wtimeoutMS:5000}});
  return result;
}
