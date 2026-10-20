import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { requireThat } from "@/lib/shop-dispatch/model";
import { photoMime } from "./workflow-inspections";
import { getDb } from "@/lib/data/db";
import { GUIDED_RO_COLLECTION } from "./guided-ro-operations";
const INDEX="guided_ro_arrival_photo_sets",MEDIA="guided_ro_arrival_photos";
export const MAX_ARRIVAL_PHOTOS=12;
export class ROArrivalPhotos {
  constructor(private db:()=>Promise<Db>=getDb){}
  async requireConfirmed(shopId:number,workOrderId:string){
    const row=await (await this.db()).collection(GUIDED_RO_COLLECTION).findOne({_id:workOrderId,shopId,state:"confirmed"} as any,{maxTimeMS:5000});
    requireThat(row,"Confirmed creation receipt required before attaching arrival photos",409);
  }
  async put(shopId:number,workOrderId:string,requestId:string,mime:string,bytes:Buffer){
    requireThat(bytes.length>0&&bytes.length<=4*1024*1024&&photoMime(bytes)===mime,
      "Choose a JPEG, PNG or WebP photo under 4 MiB",400);
    const db=await this.db(),key=`${shopId}:${workOrderId}`;
    const id=createHash("sha256").update(`${key}:${requestId}`).digest("hex").slice(0,24);
    const hash=createHash("sha256").update(bytes).digest("hex");
    try{await db.collection(INDEX).insertOne({_id:key,ids:[]} as any);}
    catch(e){if((e as {code?:number}).code!==11000)throw e;}
    await db.collection(INDEX).updateOne({_id:key,ids:{$ne:id},[`ids.${MAX_ARRIVAL_PHOTOS-1}`]:{$exists:false}} as any,
      {$push:{ids:id}} as any,{writeConcern:{w:"majority",wtimeoutMS:5000}});
    const set=await db.collection(INDEX).findOne({_id:key} as any,{maxTimeMS:5000});
    requireThat(set?.ids.includes(id),"Maximum 12 arrival photos per RO",409);
    try{
      await db.collection(MEDIA).insertOne({_id:id,shopId,workOrderId,requestId,mime,digest:hash,bytes,createdAt:new Date()} as any,
        {writeConcern:{w:"majority",wtimeoutMS:5000}});
    }catch(e){if((e as {code?:number}).code!==11000)throw e;}
    const stored=await db.collection(MEDIA).findOne({_id:id,shopId,workOrderId} as any,{projection:{bytes:0},maxTimeMS:5000});
    requireThat(stored?.digest===hash&&stored.mime===mime,"Photo request already belongs to another image",409);
    return {id,mime,url:`/api/dashboard/protractor/arrival-photos?workOrderId=${workOrderId}&mediaId=${id}`};
  }
  async list(shopId:number,workOrderId:string){
    const db=await this.db(),set=await db.collection(INDEX).findOne({_id:`${shopId}:${workOrderId}`} as any,{maxTimeMS:5000});
    const rows=await db.collection(MEDIA).find({_id:{$in:set?.ids??[]},shopId,workOrderId} as any,
      {projection:{_id:1,mime:1},maxTimeMS:5000}).limit(MAX_ARRIVAL_PHOTOS).toArray();
    return rows.map(r=>({id:String(r._id),mime:r.mime,
      url:`/api/dashboard/protractor/arrival-photos?workOrderId=${workOrderId}&mediaId=${r._id}`}));
  }
  async read(shopId:number,workOrderId:string,id:string){
    const row=await (await this.db()).collection(MEDIA).findOne({_id:id,shopId,workOrderId} as any,{maxTimeMS:5000});
    requireThat(row,"Arrival photo not found",404);
    return {mime:String(row.mime),bytes:Buffer.from(row.bytes.buffer??row.bytes)};
  }
}
