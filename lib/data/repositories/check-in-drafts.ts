import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import { getDb } from "@/lib/data/db";
import { requireThat } from "@/lib/shop-dispatch/model";
import { photoMime } from "./workflow-inspections";

export const draftFenceSchema=z.object({id:z.string().uuid(),revision:z.number().int().nonnegative(),deviceId:z.string().uuid()}).strict();
const photoSchema=z.object({requestId:z.string().uuid(),name:z.string().max(255),mime:z.enum(["image/jpeg","image/png","image/webp"]),size:z.number().int().min(1).max(4*1024*1024)}).strict();
const sessionSchema=z.object({shopId:z.number().int().positive(),actorKey:z.string().length(64),handoffRequestId:z.string().uuid(),
  draft:z.object({version:z.literal(1),fields:z.string().max(256*1024)}).strict().optional(),
  payload:z.string().max(256*1024).optional(),result:z.record(z.string(),z.unknown()).optional(),
  updatedAt:z.number().optional(),pendingCreates:z.object({contact:z.record(z.string(),z.unknown()).optional(),vehicle:z.record(z.string(),z.unknown()).optional()}).strict().optional()}).strict();
export const draftWriteSchema=draftFenceSchema.extend({
  action:z.enum(["create","save","claim","discard","photo"]),session:sessionSchema.optional(),
  photos:z.array(photoSchema).max(12).optional(),requestId:z.string().uuid().optional(),
  mime:z.enum(["image/jpeg","image/png","image/webp"]).optional(),base64:z.string().max(5592408).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),
}).strict();
export type DraftScope={shopId:number;actor:string};
export type DraftFence=z.infer<typeof draftFenceSchema>;
const COLLECTION="guided_check_in_drafts",MEDIA="guided_check_in_media";
const writeConcern={w:"majority" as const,wtimeoutMS:5000};
function canonical(v:any):any{return Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
export function draftDigest(v:unknown){return createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");}
export function nativeDraftBody(body:any){const {_guidedDraft,recoveryOnly,expectedShopId,...payload}=body;return payload;}
export class CheckInDrafts {
  constructor(private db:()=>Promise<Db>=getDb){}
  private key(s:DraftScope){return `${s.shopId}:${s.actor}`;}
  async read(s:DraftScope,id?:string):Promise<any>{
    let row=await(await this.db()).collection(COLLECTION).findOne({_id:this.key(s),...(id?{id}:{})} as any,{maxTimeMS:5000});
    if(row&&!row.session.payload&&!Object.keys(row.session.pendingCreates??{}).length&&!Object.keys(row.operations??{}).length&&Date.parse(row.updatedAt)<Date.now()-7*86400000){
      const removed=await(await this.db()).collection(COLLECTION).deleteOne({_id:this.key(s),id:row.id,revision:row.revision} as any,{writeConcern});
      if(removed.deletedCount){await(await this.db()).collection(MEDIA).deleteMany({scope:this.key(s),draftId:row.id},{writeConcern});row=null;}
    }
    if(id)requireThat(row,"Check-in draft not found for this account and shop",404);
    return row;
  }
  public(row:any){if(!row)return null;const {id,revision,ownerDeviceId,updatedAt,session,photos}=row;return {id,revision,ownerDeviceId,updatedAt,session,photos};}
  async fence(s:DraftScope,f:DraftFence){
    const r=await this.read(s,f.id);
    requireThat(r.revision===f.revision&&r.ownerDeviceId===f.deviceId,"This draft changed or moved to another device. Refresh and resume its saved copy.",409);
    return r;
  }
  private async cas(s:DraftScope,row:any,fields:any){
    const result=await(await this.db()).collection(COLLECTION).updateOne({_id:this.key(s),id:row.id,revision:row.revision} as any,
      {$set:{...fields,updatedAt:new Date().toISOString()},$inc:{revision:1}},{writeConcern});
    requireThat(result.matchedCount===1,"Check-in changed on another device. Refresh before continuing.",409);
    return this.read(s,row.id);
  }
  async write(s:DraftScope,raw:unknown){
    const input=draftWriteSchema.parse(raw),{action,...f}=input;
    if(action==="create"||action==="save"){
      requireThat(input.session&&input.photos,"Draft details required",400);
      requireThat(input.session.shopId===s.shopId&&input.session.actorKey===s.actor&&input.session.handoffRequestId===input.id,"Draft scope mismatch",403);
      requireThat(Buffer.byteLength(JSON.stringify(input.session))<=300000&&new Set(input.photos.map(p=>p.requestId)).size===input.photos.length,"Invalid draft size or duplicate photos",400);
    }
    if(action==="create"){
      requireThat(input.revision===0&&!input.session!.payload&&!input.session!.result&&!Object.keys(input.session!.pendingCreates??{}).length,"Resolve submitted requests on the original device before sharing",409);
      const row={_id:this.key(s),id:input.id,revision:1,ownerDeviceId:input.deviceId,updatedAt:new Date().toISOString(),
        session:input.session,photos:input.photos!.map(p=>({...p,saved:false})),operations:{},initialDigest:draftDigest(input)};
      try{await(await this.db()).collection(COLLECTION).insertOne(row as any,{writeConcern});return row;}
      catch(e){if((e as any).code!==11000)throw e;const existing=await this.read(s);
        requireThat(existing?.id===input.id&&existing.initialDigest===row.initialDigest,"Another shared draft is active. Resume or explicitly discard it.",409);return existing;}
    }
    let row=action==="claim"?await this.read(s,f.id):await this.fence(s,f);
    if(action==="claim"){
      requireThat(row.revision===f.revision,"Draft changed. Refresh before taking over.",409);
      return this.cas(s,row,{ownerDeviceId:input.deviceId});
    }
    if(action==="discard"){
      requireThat(!Object.values(row.operations??{}).some((v:any)=>!v.result)&&!Object.keys(row.session.pendingCreates??{}).length,"An unresolved operation cannot be discarded",409);
      requireThat(!row.session.payload||(row.session.result&&row.photos.every((p:any)=>p.uploaded)),"Finish the confirmed RO and all photo uploads before clearing the draft",409);
      const d=await(await this.db()).collection(COLLECTION).deleteOne({_id:this.key(s),id:row.id,revision:row.revision} as any,{writeConcern});
      requireThat(d.deletedCount===1,"Draft changed before discard",409);
      await(await this.db()).collection(MEDIA).deleteMany({scope:this.key(s),draftId:row.id},{writeConcern});
      return null;
    }
    if(action==="photo"){
      requireThat(input.requestId&&input.mime&&input.base64,"Photo required",400);
      const meta=row.photos.find((p:any)=>p.requestId===input.requestId),bytes=Buffer.from(input.base64,"base64");
      requireThat(meta&&meta.mime===input.mime&&bytes.length===meta.size&&bytes.length<=4*1024*1024&&photoMime(bytes)===input.mime,"Invalid photo bytes or metadata",400);
      if(!(row.mediaIds??[]).includes(input.requestId)){
        requireThat((row.mediaIds??[]).length<12,"This check-in has reached its 12-photo storage limit",409);
        row=await this.cas(s,row,{mediaIds:[...(row.mediaIds??[]),input.requestId]});
      }
      const mediaId=`${this.key(s)}:${row.id}:${input.requestId}`,digest=createHash("sha256").update(bytes).digest("hex");
      try{await(await this.db()).collection(MEDIA).insertOne({_id:mediaId,scope:this.key(s),draftId:row.id,mime:input.mime,bytes,digest} as any,{writeConcern});}
      catch(e){if((e as any).code!==11000)throw e;
        const old=await(await this.db()).collection(MEDIA).findOne({_id:mediaId} as any,{projection:{digest:1},maxTimeMS:5000});
        requireThat(old?.digest===digest,"This photo identity already belongs to different bytes",409);}
      return this.cas(s,row,{photos:row.photos.map((p:any)=>p.requestId===input.requestId?{...p,saved:true}:p)});
    }
    const next=input.session!;
    requireThat(!row.session.payload||row.session.payload===next.payload,"Submitted RO details are frozen",409);
    requireThat(!next.result||draftDigest(next.result)===draftDigest(row.session.result??{}),"RO confirmation must come from the server",409);
    requireThat(!row.session.result||!!next.result,"Confirmed RO receipt cannot be removed",409);
    for(const kind of ["contact","vehicle"] as const){
      const pending=row.session.pendingCreates?.[kind],replacement=next.pendingCreates?.[kind],op=row.operations?.[kind];
      if(pending)requireThat(replacement?draftDigest(replacement)===draftDigest(pending):!!op?.result,"Pending native details cannot change or be removed",409);
      if(pending&&!replacement){
        const fields=JSON.parse(next.draft?.fields??"{}"),selection=kind==="contact"?fields.selectedContact:fields.selectedVehicle;
        const id=kind==="contact"?op.result.contactId:op.result.vehicleId;
        requireThat(selection?.id===id,"Recovered selection must match the confirmed record",409);
      }
    }
    const photos=input.photos!.map(p=>{
      const prior=row.photos.find((v:any)=>v.requestId===p.requestId);
      requireThat(!prior||(prior.mime===p.mime&&prior.size===p.size),"Photo identity cannot change",409);
      return {...p,saved:prior?.saved??false,...(prior?.uploaded?{uploaded:prior.uploaded}:{})};
    });
    requireThat(!row.session.payload||draftDigest(photos.map(p=>p.requestId))===draftDigest(row.photos.map((p:any)=>p.requestId)),"Submitted photos are frozen",409);
    return this.cas(s,row,{session:next,photos});
  }
  async photo(s:DraftScope,id:string,photoId:string){
    const row=await this.read(s,id);
    requireThat(row.photos.some((p:any)=>p.requestId===photoId&&p.saved),"Saved photo not found",404);
    const p=await(await this.db()).collection(MEDIA).findOne({_id:`${this.key(s)}:${id}:${photoId}`} as any,{maxTimeMS:5000});
    requireThat(p,"Saved photo is unavailable",503);
    return {mime:String(p.mime),bytes:Buffer.from(p.bytes.buffer??p.bytes)};
  }
  async reserve(s:DraftScope,f:DraftFence,kind:string,payload:unknown){
    const row=await this.fence(s,f),digest=draftDigest(payload),old=row.operations?.[kind];
    if(old){requireThat(old.digest===digest,"Native operation details are frozen",409);return {send:false,result:old.result??null};}
    requireThat(!Object.values(row.operations??{}).some((v:any)=>!v.result),"Resolve the pending operation before starting another",409);
    if(kind==="ro")requireThat(row.session.payload&&draftDigest(nativeDraftBody(JSON.parse(row.session.payload)))===digest,"Save the exact RO request before creation",409);
    else requireThat(row.session.pendingCreates?.[kind]&&draftDigest(nativeDraftBody(row.session.pendingCreates[kind]))===digest,"Save the exact native request before creation",409);
    await this.cas(s,row,{[`operations.${kind}`]:{digest,payload,state:"pending"}});
    return {send:true,result:null};
  }
  async confirm(s:DraftScope,id:string,kind:string,payload:unknown,result:any){
    requireThat(result&&((kind==="ro"&&result.ok===true)||(kind!=="ro"&&result.success===true)),"Native confirmation required",503);
    const set:any={[`operations.${kind}.result`]:result,[`operations.${kind}.state`]:"confirmed",updatedAt:new Date().toISOString()};
    if(kind==="ro")set["session.result"]={workOrderId:result.workOrderId,workOrderNumber:result.workOrderNumber,packagesWithoutLines:result.packagesWithoutLines??[]};
    const r=await(await this.db()).collection(COLLECTION).updateOne({_id:this.key(s),id,[`operations.${kind}.digest`]:draftDigest(payload)} as any,{$set:set,$inc:{revision:1}},{writeConcern});
    requireThat(r.matchedCount===1,"Native receipt could not be retained",503);
  }
  async attachPhoto(s:DraftScope,f:DraftFence,photoId:string,workOrderId:string,receipt:any){
    const row=await this.fence(s,f);
    requireThat(row.session.result?.workOrderId===workOrderId&&row.photos.some((p:any)=>p.requestId===photoId&&p.saved),"Confirmed draft photo and RO required",409);
    return this.cas(s,row,{photos:row.photos.map((p:any)=>p.requestId===photoId?{...p,uploaded:receipt}:p)});
  }
  async reserveScan(s:DraftScope,f:DraftFence,photoId:string,requestId:string){
    const row=await this.fence(s,f);
    requireThat(row.photos.some((p:any)=>p.requestId===photoId&&p.saved),"Save the photo before scanning",409);
    const prior=row.scans?.[photoId];
    // One paid interpretation per immutable photo; upload a new photo to retry.
    if(prior)return {send:false,result:prior.result??null};
    await this.cas(s,row,{[`scans.${photoId}`]:{requestId,state:"pending"}});
    return {send:true,result:null};
  }
  async confirmScan(s:DraftScope,id:string,photoId:string,result:any){
    await(await this.db()).collection(COLLECTION).updateOne({_id:this.key(s),id,[`scans.${photoId}.state`]:"pending"} as any,
      {$set:{[`scans.${photoId}.result`]:result,[`scans.${photoId}.state`]:"confirmed"},$inc:{revision:1}},{writeConcern});
  }
}
