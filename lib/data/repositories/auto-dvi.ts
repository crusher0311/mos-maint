// Task #991 — Auto DVI repository: all Mongo access for the Auto DVI
// feature (shop custom inspection items on the shops doc, the per-shop AI
// name→service-key cache, application analytics records, and the open-RO
// lookup used by the Tekmetric push path).

import { Readable } from "stream";
import { GridFSBucket, ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";
import { resolveOpenRoMileage } from "@/lib/plan-build/open-ro-mileage";

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
