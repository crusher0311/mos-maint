// Task #991 — Auto DVI repository: all Mongo access for the Auto DVI
// feature (shop custom inspection items on the shops doc, the per-shop AI
// name→service-key cache, application analytics records, and the open-RO
// lookup used by the Tekmetric push path).

import { Readable } from "stream";
import { GridFSBucket, ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";
import { resolveOpenRoMileage } from "@/lib/plan-build/open-ro-mileage";
import { randomUUID } from "node:crypto";
import { applyVisitAction, BUILTIN_SHEETS, validateSheet, VisitError, type VisitRecord, type Sheet, type Media } from "@/lib/auto-dvi/visit-model";

// Separate versioned visit store: legacy VIN-only inspections remain unchanged.
const VISITS_COLLECTION = "auto_dvi_visit_records";
export async function readDviVisits(shopId:number,vin:string):Promise<VisitRecord>{
  const db=await getDb();
  const row=await db.collection(VISITS_COLLECTION).findOne({_id:`${shopId}:${vin}`} as any,{maxTimeMS:5000});
  return row?{revision:row.revision,visits:row.visits}:{revision:0,visits:[]};
}
async function commitDviVisits(shopId:number,vin:string,revision:number,next:VisitRecord,actor:string){
  const db=await getDb();const coll=db.collection(VISITS_COLLECTION);
  const id=`${shopId}:${vin}`;
  if(revision===0){
    try{await coll.insertOne({_id:id,shopId,vin,...next,updatedBy:actor,updatedAt:new Date()} as any);}
    catch(e:any){if(e.code===11000)throw new VisitError("Inspection changed. Refresh before saving.",409);throw e;}
  }else{
    const result=await coll.updateOne({_id:id,revision} as any,{$set:{...next,updatedBy:actor,updatedAt:new Date()}});
    if(result.matchedCount!==1)throw new VisitError("Inspection changed. Refresh before saving.",409);
  }
  return next;
}
export async function mutateDviVisits(shopId:number,vin:string,revision:number,action:any,actor:string){
  const record=await readDviVisits(shopId,vin);
  if(record.revision!==revision)throw new VisitError("Inspection changed. Refresh before saving.",409);
  if(action.action==="selectSheet"){
    const templates=await readDviSheets(shopId);
    const sheet=templates.templates.find(t=>t.id===action.sheet?.id);
    if(!sheet)throw new VisitError("Sheet no longer exists; refresh",409);
    action={...action,sheet}; // Never accept client-authored completion requirements.
  }
  const next=applyVisitAction(record,action,new Date().toISOString(),randomUUID());
  return commitDviVisits(shopId,vin,revision,next,actor);
}
export async function readDviSheets(shopId:number):Promise<{templateRevision:number;templates:Sheet[]}>{
  const db=await getDb();
  const row=await db.collection("auto_dvi_sheet_templates").findOne({_id:String(shopId)} as any,{maxTimeMS:5000});
  return {templateRevision:row?.revision??0,templates:[...BUILTIN_SHEETS,...(row?.sheets??[])]};
}
export async function mutateDviSheets(shopId:number,revision:number,action:any){
  const current=await readDviSheets(shopId);
  if(current.templateRevision!==revision)throw new VisitError("Sheets changed; refresh",409);
  const id=action.action==="templateDelete"?action.sheetId:action.sheet?.id;
  if(BUILTIN_SHEETS.some(s=>s.id===id))throw new VisitError("Built-in sheets cannot be changed");
  let sheets=current.templates.filter(s=>!BUILTIN_SHEETS.some(b=>b.id===s.id));
  if(action.action==="templateDelete"){
    if(!sheets.some(s=>s.id===id))throw new VisitError("Sheet not found",404);
    sheets=sheets.filter(s=>s.id!==id);
  }else{
    const sheet=validateSheet(action.sheet);
    sheets=sheets.filter(s=>s.id!==id);sheets.push(sheet);
    if(sheets.length>20)throw new VisitError("Maximum 20 custom sheets");
  }
  const db=await getDb();const coll=db.collection("auto_dvi_sheet_templates");
  if(revision===0){
    try{await coll.insertOne({_id:String(shopId),revision:1,sheets} as any);}
    catch(e:any){if(e.code===11000)throw new VisitError("Sheets changed; refresh",409);throw e;}
  }else{
    const r=await coll.updateOne({_id:String(shopId),revision} as any,{$set:{sheets,revision:revision+1}});
    if(r.matchedCount!==1)throw new VisitError("Sheets changed; refresh",409);
  }
  return {templateRevision:revision+1,templates:[...BUILTIN_SHEETS,...sheets]};
}
export async function attachDviVisitMedia(opts:{shopId:number;vin:string;visitId:string;itemId:string;revision:number;filename:string;contentType:string;kind:"photo"|"video";buffer:Buffer;actor:string}){
  const record=await readDviVisits(opts.shopId,opts.vin);
  if(record.revision!==opts.revision)throw new VisitError("Inspection changed; refresh",409);
  const visit=record.visits.find(v=>v.id===opts.visitId);
  if(!visit||visit.status!=="in_progress"||!visit.sheet.itemIds.includes(opts.itemId))throw new VisitError("No editable inspection item",409);
  const item=visit.results[opts.itemId]??{rating:null,notes:"",recommendation:"",values:{},media:[]};
  if(item.media.length>=6)throw new VisitError("Maximum six attachments per item");
  const db=await getDb();const bucket=new GridFSBucket(db as any,{bucketName:"auto_dvi_visit_media"});
  const upload=bucket.openUploadStream(opts.filename,{metadata:{shopId:opts.shopId,vin:opts.vin,visitId:opts.visitId,itemId:opts.itemId,contentType:opts.contentType}});
  await new Promise<void>((resolve,reject)=>Readable.from(opts.buffer).pipe(upload).on("finish",resolve).on("error",reject));
  const ref:Media={mediaId:String(upload.id),kind:opts.kind,filename:opts.filename};
  item.media.push(ref);visit.results[opts.itemId]=item;record.revision++;
  try{return await commitDviVisits(opts.shopId,opts.vin,opts.revision,record,opts.actor);}
  catch(e){await bucket.delete(upload.id).catch(()=>{});throw e;}
}
export async function readDviVisitMedia(shopId:number,vin:string,visitId:string,mediaId:string){
  if(!ObjectId.isValid(mediaId))throw new VisitError("Media not found",404);
  const record=await readDviVisits(shopId,vin);
  const visit=record.visits.find(v=>v.id===visitId);
  if(!visit||!Object.values(visit.results).some(r=>r.media.some(m=>m.mediaId===mediaId)))throw new VisitError("Media not found",404);
  const db=await getDb();const bucket=new GridFSBucket(db as any,{bucketName:"auto_dvi_visit_media"});
  const file=await db.collection("auto_dvi_visit_media.files").findOne({_id:new ObjectId(mediaId),"metadata.shopId":shopId,"metadata.vin":vin,"metadata.visitId":visitId},{maxTimeMS:5000});
  if(!file||file.length>40*1024*1024)throw new VisitError("Media not found",404);
  const chunks:Buffer[]=[];for await(const chunk of bucket.openDownloadStream(file._id))chunks.push(Buffer.from(chunk));
  return {buffer:Buffer.concat(chunks),contentType:file.metadata?.contentType as string};
}

const AI_CACHE_COLLECTION = "auto_dvi_ai_key_cache";
const APPLICATIONS_COLLECTION = "auto_dvi_applications";
const INSPECTIONS_COLLECTION = "auto_dvi_inspections";
const MEDIA_BUCKET = "auto_dvi_media";

export interface StoredAutoDviItem {
  id: string;
  name: string;
  group: string | null;
  notes: string | null;
}

/** Raw stored items (settings GET). Returns [] when unset. */
export async function readShopAutoDviItems(shopId: number): Promise<StoredAutoDviItem[]> {
  const db = await getDb();
  const shop = await db
    .collection("shops")
    .findOne({ shopId }, { projection: { "preferences.autoDviItems": 1 } });
  const raw = shop?.preferences?.autoDviItems;
  return Array.isArray(raw) ? raw : [];
}

export async function writeShopAutoDviItems(shopId: number, items: StoredAutoDviItem[]): Promise<void> {
  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId },
    { $set: { "preferences.autoDviItems": items, updatedAt: new Date() } },
  );
}

/** Shop's cached labor rate (kept fresh by job indexing), for pricing
 * recommended-work packages. Null when never observed. */
export async function readShopCachedLaborRate(shopId: number): Promise<number | null> {
  const db = await getDb();
  const shop = await db
    .collection("shops")
    .findOne({ shopId }, { projection: { cachedLaborRate: 1 } });
  const rate = Number(shop?.cachedLaborRate);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Shop provider check used by the dashboard push route. */
export async function isProtractorShop(shopId: number): Promise<boolean> {
  const db = await getDb();
  const shop = await db
    .collection("shops")
    .findOne(
      { shopId },
      { projection: { integrationProvider: 1, protractor: 1, protractorApiKey: 1 } },
    );
  return (
    shop?.integrationProvider === "protractor" ||
    !!shop?.protractor?.configured ||
    !!shop?.protractorApiKey
  );
}

export interface VinMileageContext {
  /** Odometer from the newest open/cached RO for this VIN (provider-aware). */
  openRoMiles: number | null;
  /** Stale `vehicles`-collection mileage snapshot (shop-scoped read). */
  vehicleDocMileage: number | null;
  /** Model year from the vehicles doc, if present (skips a DataOne lookup). */
  knownYear: number | null;
}

/**
 * Mileage inputs for the composer's fallback waterfall when the caller has
 * no odometer (dashboard plan page). Vehicles reads MUST stay shop-scoped
 * (vehicles docs are VIN-keyed with inconsistent shopId types).
 */
export async function readVinMileageContext(
  shopId: number,
  vinUpper: string,
): Promise<VinMileageContext> {
  const db = await getDb();
  const shop = await db
    .collection("shops")
    .findOne({ shopId }, { projection: { integrationProvider: 1 } });
  const shopIdVariants = [shopId, String(shopId)];
  const [openRo, veh] = await Promise.all([
    resolveOpenRoMileage({
      db,
      shopIdVariants,
      vin: vinUpper,
      provider: shop?.integrationProvider || null,
    }).catch(() => null),
    db.collection("vehicles").findOne(
      { vin: vinUpper, shopId: { $in: shopIdVariants } },
      { projection: { mileage: 1, year: 1 } },
    ),
  ]);
  const docMiles = Number(veh?.mileage);
  const year = Number(veh?.year);
  return {
    openRoMiles: openRo && Number(openRo.miles) > 0 ? Number(openRo.miles) : null,
    vehicleDocMileage: Number.isFinite(docMiles) && docMiles > 0 ? docMiles : null,
    knownYear: Number.isFinite(year) && year > 1900 ? year : null,
  };
}

/** Read cached AI name→key answers for a shop. Map key = normalized nameKey. */
export async function readAiKeyCache(
  shopId: number,
  nameKeys: string[],
): Promise<Map<string, string | null>> {
  const db = await getDb();
  const rows = await db
    .collection(AI_CACHE_COLLECTION)
    .find({ shopId, nameKey: { $in: nameKeys } })
    .toArray();
  return new Map(rows.map((r: any) => [r.nameKey, r.serviceKey ?? null]));
}

export interface AiKeyCacheEntry {
  nameKey: string;
  name: string;
  serviceKey: string | null;
}

/** Upsert AI answers (including null = known-unmatchable). Fire-and-forget safe. */
export async function writeAiKeyCache(shopId: number, entries: AiKeyCacheEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  await db.collection(AI_CACHE_COLLECTION).bulkWrite(
    entries.map((e) => ({
      updateOne: {
        filter: { shopId, nameKey: e.nameKey },
        update: {
          $set: { shopId, nameKey: e.nameKey, name: e.name, serviceKey: e.serviceKey, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

// ---------------------------------------------------------------------------
// Inspection results (per-item rating / notes / recommendation / media) —
// one active inspection record per shop+VIN, upserted as the tech works.
// ---------------------------------------------------------------------------

export type InspectionRating = "green" | "yellow" | "red";

export interface InspectionMediaRef {
  mediaId: string;
  kind: "photo" | "video";
  contentType: string;
  size: number;
  filename: string | null;
  uploadedAt: Date;
}

export interface InspectionItemResult {
  itemId: string;
  name: string;
  rating: InspectionRating | null;
  notes: string | null;
  recommendation: string | null;
  media: InspectionMediaRef[];
}

export interface InspectionResultsDoc {
  shopId: number;
  vin: string;
  items: InspectionItemResult[];
  status: "in_progress" | "pushed";
  updatedBy: string | null;
  updatedAt: Date;
}

export async function readInspectionResults(
  shopId: number,
  vinUpper: string,
): Promise<InspectionResultsDoc | null> {
  const db = await getDb();
  const doc = await db.collection(INSPECTIONS_COLLECTION).findOne({ shopId, vin: vinUpper });
  if (!doc) return null;
  return {
    shopId,
    vin: vinUpper,
    items: Array.isArray(doc.items) ? doc.items : [],
    status: doc.status === "pushed" ? "pushed" : "in_progress",
    updatedBy: doc.updatedBy ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

/**
 * Merge per-item findings into the shop+VIN inspection record. Only the
 * fields present on each patch are updated; media refs are preserved.
 */
export async function saveInspectionResults(opts: {
  shopId: number;
  vinUpper: string;
  items: Array<{
    itemId: string;
    name: string;
    rating?: InspectionRating | null;
    notes?: string | null;
    recommendation?: string | null;
  }>;
  status?: "in_progress" | "pushed";
  updatedBy: string | null;
}): Promise<InspectionResultsDoc> {
  const db = await getDb();
  const coll = db.collection(INSPECTIONS_COLLECTION);
  const existing = await coll.findOne({ shopId: opts.shopId, vin: opts.vinUpper });
  const byId = new Map<string, InspectionItemResult>(
    (Array.isArray(existing?.items) ? existing.items : []).map((it: any) => [String(it.itemId), it]),
  );
  for (const patch of opts.items) {
    const prev = byId.get(patch.itemId);
    byId.set(patch.itemId, {
      itemId: patch.itemId,
      name: patch.name || prev?.name || patch.itemId,
      rating: patch.rating !== undefined ? patch.rating : prev?.rating ?? null,
      notes: patch.notes !== undefined ? patch.notes : prev?.notes ?? null,
      recommendation:
        patch.recommendation !== undefined ? patch.recommendation : prev?.recommendation ?? null,
      media: prev?.media ?? [],
    });
  }
  const items = Array.from(byId.values());
  const status = opts.status ?? (existing?.status === "pushed" ? "pushed" : "in_progress");
  const now = new Date();
  await coll.updateOne(
    { shopId: opts.shopId, vin: opts.vinUpper },
    {
      $set: { items, status, updatedBy: opts.updatedBy, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return { shopId: opts.shopId, vin: opts.vinUpper, items, status, updatedBy: opts.updatedBy, updatedAt: now };
}

/** Store a media file in GridFS and attach its ref to the inspection item. */
export async function storeInspectionMedia(opts: {
  shopId: number;
  vinUpper: string;
  itemId: string;
  itemName: string;
  kind: "photo" | "video";
  contentType: string;
  filename: string | null;
  buffer: Buffer;
}): Promise<InspectionMediaRef> {
  const db = await getDb();
  const bucket = new GridFSBucket(db as any, { bucketName: MEDIA_BUCKET });
  const uploadStream = bucket.openUploadStream(opts.filename || `${opts.kind}-${Date.now()}`, {
    contentType: opts.contentType,
    metadata: { shopId: opts.shopId, vin: opts.vinUpper, itemId: opts.itemId, kind: opts.kind },
  });
  await new Promise<void>((resolve, reject) => {
    Readable.from(opts.buffer).pipe(uploadStream).on("finish", () => resolve()).on("error", reject);
  });
  const ref: InspectionMediaRef = {
    mediaId: String(uploadStream.id),
    kind: opts.kind,
    contentType: opts.contentType,
    size: opts.buffer.length,
    filename: opts.filename,
    uploadedAt: new Date(),
  };

  const coll = db.collection(INSPECTIONS_COLLECTION);
  const existing = await coll.findOne({ shopId: opts.shopId, vin: opts.vinUpper });
  const items: InspectionItemResult[] = Array.isArray(existing?.items) ? existing.items : [];
  const idx = items.findIndex((it: any) => String(it.itemId) === opts.itemId);
  if (idx >= 0) {
    items[idx].media = [...(items[idx].media || []), ref];
  } else {
    items.push({ itemId: opts.itemId, name: opts.itemName, rating: null, notes: null, recommendation: null, media: [ref] });
  }
  const now = new Date();
  await coll.updateOne(
    { shopId: opts.shopId, vin: opts.vinUpper },
    { $set: { items, updatedAt: now }, $setOnInsert: { createdAt: now, status: "in_progress" } },
    { upsert: true },
  );
  return ref;
}

/** Shop-scoped media read. Returns null when the id is unknown OR belongs to another shop. */
export async function readInspectionMedia(
  shopId: number,
  mediaId: string,
): Promise<{ buffer: Buffer; contentType: string; filename: string | null } | null> {
  if (!ObjectId.isValid(mediaId)) return null;
  const db = await getDb();
  const id = new ObjectId(mediaId);
  const fileDoc = await db.collection(`${MEDIA_BUCKET}.files`).findOne({ _id: id });
  if (!fileDoc || Number(fileDoc.metadata?.shopId) !== shopId) return null;
  const bucket = new GridFSBucket(db as any, { bucketName: MEDIA_BUCKET });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    bucket
      .openDownloadStream(id)
      .on("data", (c) => chunks.push(c))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return {
    buffer: Buffer.concat(chunks),
    contentType: fileDoc.contentType || fileDoc.metadata?.contentType || "application/octet-stream",
    filename: fileDoc.filename ?? null,
  };
}

/** Shop-scoped media delete: removes the GridFS file + the item's ref. */
export async function deleteInspectionMedia(
  shopId: number,
  vinUpper: string,
  mediaId: string,
): Promise<boolean> {
  if (!ObjectId.isValid(mediaId)) return false;
  const db = await getDb();
  const id = new ObjectId(mediaId);
  const fileDoc = await db.collection(`${MEDIA_BUCKET}.files`).findOne({ _id: id });
  if (!fileDoc || Number(fileDoc.metadata?.shopId) !== shopId) return false;
  const bucket = new GridFSBucket(db as any, { bucketName: MEDIA_BUCKET });
  await bucket.delete(id);
  await db.collection(INSPECTIONS_COLLECTION).updateOne(
    { shopId, vin: vinUpper },
    { $pull: { "items.$[].media": { mediaId } } as any, $set: { updatedAt: new Date() } },
  );
  return true;
}

export interface AutoDviApplicationRecord {
  shopId: number;
  vin: string | null;
  provider: string;
  repairOrderId: string | null;
  itemCount: number;
  appliedBy: string | null;
  mode: "server_write" | "client_write";
}

export async function recordAutoDviApplication(record: AutoDviApplicationRecord): Promise<void> {
  const db = await getDb();
  await db.collection(APPLICATIONS_COLLECTION).insertOne({ ...record, appliedAt: new Date() });
}

/**
 * Newest non-terminal cached Tekmetric RO for a VIN (same resolution the
 * add-declined-work flow uses). Returns the numeric Tekmetric RO id or null.
 */
export async function findOpenTekmetricRoIdByVin(
  mosShopId: number,
  vinUpper: string,
): Promise<number | null> {
  const db = await getDb();
  const cached = await db.collection("tekmetric_work_orders").findOne(
    {
      shopId: { $in: [String(mosShopId), Number(mosShopId)] },
      vin: vinUpper,
      status: { $nin: ["Invoiced", "Void", "Archived"] },
    },
    { sort: { fetchedAt: -1, updatedDate: -1 } },
  );
  if (!cached) return null;
  const fromWorkOrderId = cached.workOrderId ? Number(cached.workOrderId) : NaN;
  const fromData = cached.data?.id ? Number(cached.data.id) : NaN;
  return !isNaN(fromWorkOrderId) ? fromWorkOrderId : !isNaN(fromData) ? fromData : null;
}
