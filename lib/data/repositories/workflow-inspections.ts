import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { getDb } from "@/lib/data/db";
import { emptyShopState, validateShopState, type ShopState, type StaffPersistence } from "@/lib/auto-dvi/staff/store";
import { requireThat } from "@/lib/shop-dispatch/model";

export const STAFF_COLLECTION = "workflow_staff_inspections";
export const STAFF_MEDIA_BUCKET = "workflow_staff_inspection_media";
/** Injected Db in isolated tests; application uses the existing repository DB. */
export class MongoStaffPersistence implements StaffPersistence {
  constructor(private database: () => Promise<Db> = getDb) {}
  async read(shopId: number) {
    const db = await this.database();
    const row = await db.collection(STAFF_COLLECTION).findOne({_id: `shop:${shopId}`} as any, {maxTimeMS: 5000});
    if (!row) return emptyShopState();
    const {_id, ...state} = row;
    return validateShopState(state);
  }
  async cas(shopId: number, revision: number, state: ShopState) {
    const db = await this.database(), col = db.collection(STAFF_COLLECTION);
    const doc = {_id: `shop:${shopId}`, ...validateShopState(state)};
    if (revision === 0) {
      try {await col.insertOne(doc as any, {writeConcern: {w: "majority", wtimeoutMS: 5000}}); return true;}
      catch (e) {if ((e as {code?: number}).code === 11000) return false; throw e;}
    }
    return (await col.replaceOne({_id: doc._id, revision} as any, doc as any,
      {writeConcern: {w: "majority", wtimeoutMS: 5000}})).modifiedCount === 1;
  }
}
export async function readStaffConfiguration(key: string) {
  return (await getDb()).collection("workflow_staff_inspection_config").findOne({_id: key} as any, {maxTimeMS: 5000});
}
export function photoMime(bytes: Buffer) {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
export class StaffMediaStorage {
  constructor(private database: () => Promise<Db> = getDb) {}
  async upload(id: string, bytes: Buffer, metadata: {shopId: number; visitId: string; sheet: string; item: string; requestId: string; actor: string; mime: string}) {
    requireThat(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024 && photoMime(bytes) === metadata.mime, "Choose a JPEG, PNG or WebP photo under 4 MiB", 400);
    const db = await this.database();
    const existing = await db.collection(`${STAFF_MEDIA_BUCKET}.files`).findOne({_id: new ObjectId(id)}, {maxTimeMS: 5000});
    if (existing) {
      requireThat(existing.metadata?.shopId === metadata.shopId && existing.metadata?.requestId === metadata.requestId &&
        existing.metadata?.actor === metadata.actor && existing.metadata?.visitId === metadata.visitId, "Photo ownership conflict", 409);
      return;
    }
    const bucket = new GridFSBucket(db, {bucketName: STAFF_MEDIA_BUCKET, writeConcern: {w: "majority", wtimeoutMS: 5000}});
    const upload = bucket.openUploadStreamWithId(new ObjectId(id), "internal-photo", {metadata: {...metadata, uploadedAt: new Date()}});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {upload.destroy(new Error("Upload deadline exceeded"));}, 10000);
      upload.once("error", e => {clearTimeout(timer); reject(e);});
      upload.once("finish", () => {clearTimeout(timer); resolve();});
      upload.end(bytes);
    });
  }
  async deleteAbandoned(id: string) {
    const db = await this.database();
    // Also cleans chunks after process death before the GridFS files row exists.
    await db.collection(`${STAFF_MEDIA_BUCKET}.chunks`).deleteMany({files_id: new ObjectId(id)}, {maxTimeMS: 5000});
    await db.collection(`${STAFF_MEDIA_BUCKET}.files`).deleteOne({_id: new ObjectId(id)}, {maxTimeMS: 5000});
  }
  async read(id: string, shopId: number, visitId: string) {
    requireThat(/^[a-f0-9]{24}$/.test(id), "Photo not found", 404);
    const db = await this.database(), _id = new ObjectId(id);
    const file = await db.collection(`${STAFF_MEDIA_BUCKET}.files`).findOne({_id, "metadata.shopId": shopId, "metadata.visitId": visitId}, {maxTimeMS: 5000});
    requireThat(file && file.length > 0 && file.length <= 4 * 1024 * 1024, "Photo not found", 404);
    const stream = new GridFSBucket(db, {bucketName: STAFF_MEDIA_BUCKET}).openDownloadStream(_id);
    const bytes: Buffer[] = [];
    const timer = setTimeout(() => stream.destroy(new Error("Photo read deadline exceeded")), 10000);
    try {for await (const part of stream) bytes.push(Buffer.from(part));}
    finally {clearTimeout(timer);}
    return {bytes: Buffer.concat(bytes), mime: String(file.metadata.mime)};
  }
}
