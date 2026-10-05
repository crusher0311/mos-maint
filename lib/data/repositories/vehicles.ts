// Repository for the `vehicles` collection.
//
// The vehicles collection is one of the largest in the system (every
// VIN we've ever seen via webhooks, manual entry, or extension).
// Callers vary a lot, so this surface stays generic on `Filter` /
// `UpdateFilter` rather than inventing a named function for every
// query shape.
import type {
  Collection,
  Document,
  Filter,
  UpdateFilter,
  WithId,
} from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isLegacyVehiclesPgCanonical,
  shouldShadowWriteMongoLegacyVehicles,
  shadowWriteMongoLegacyStore,
} from "@/lib/db/legacy-store-write-mode";
import * as pg from "./pg/pre-normalized";

const COLLECTION = "vehicles";
const MANUAL_COLLECTION = "manual_vehicles";

export interface VehicleDoc {
  vin?: string;
  shopId?: number | string;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  lastMileage?: number | null;
  declined?: unknown;
  components?: unknown;
  updatedAt?: Date;
  createdAt?: Date;
  [extra: string]: unknown;
}

type TerminalVehicleMatch = Document & {
  __pgTerminalMatch?: Document;
  __mongoTerminalMatch?: Document;
};

async function collection(): Promise<Collection<VehicleDoc>> {
  const db = await getDb();
  return db.collection<VehicleDoc>(COLLECTION);
}

export async function findVehicle(
  filter: Filter<VehicleDoc>,
  projection?: Record<string, 0 | 1>,
): Promise<WithId<VehicleDoc> | null> {
  const col = await collection();
  return col.findOne(filter, projection ? { projection } : undefined);
}

export async function findVehicles(
  filter: Filter<VehicleDoc>,
  options: {
    sort?: Record<string, 1 | -1>;
    limit?: number;
    projection?: Record<string, 0 | 1>;
  } = {},
): Promise<WithId<VehicleDoc>[]> {
  const col = await collection();
  const cursor = col.find(filter);
  if (options.sort) cursor.sort(options.sort);
  if (options.projection) cursor.project(options.projection);
  if (options.limit) cursor.limit(options.limit);
  return cursor.toArray();
}

export async function countVehicles(
  filter: Filter<VehicleDoc>,
): Promise<number> {
  const col = await collection();
  return col.countDocuments(filter);
}

export async function updateVehicle(
  filter: Filter<VehicleDoc>,
  update: UpdateFilter<VehicleDoc>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const col = await collection();
  const res = await col.updateOne(filter, update);
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}

export async function upsertVehicle(
  filter: Filter<VehicleDoc>,
  update: UpdateFilter<VehicleDoc>,
): Promise<{ matchedCount: number; modifiedCount: number; upsertedId: unknown }> {
  const col = await collection();
  const res = await col.updateOne(filter, update, { upsert: true });
  return {
    matchedCount: res.matchedCount,
    modifiedCount: res.modifiedCount,
    upsertedId: res.upsertedId,
  };
}

export async function aggregateVehicles<T extends Document = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const col = await collection();
  return col.aggregate<T>(pipeline).toArray();
}

/* -------------------------------------------------------------------------- */
/* Gated named helpers (task #1000)                                            */
/*                                                                             */
/* These are the narrow VIN-keyed shapes the central lib call sites use.      */
/* Each dispatches on `isLegacyVehiclesPgCanonical()`: OFF (default) runs the  */
/* original Mongo body verbatim; ON reads Postgres and, for writes, replays    */
/* the Mongo write via `shadowWriteMongoLegacyStore` when the shadow flag is   */
/* still on. The generic Filter/UpdateFilter surface above stays Mongo-only;   */
/* it is used by the long-tail route/page callers that remain on Mongo under   */
/* shadow writes.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * VIN-keyed vehicle read, optionally shop-scoped. Mirrors the legacy
 * `vehicles.findOne({ vin })` / `findOne({ shopId, vin })` call sites.
 * `shopId` matches String+Number variants (legacy writers stored either)
 * OR a missing shopId, preserving the Mongo `$in` semantics.
 */
export async function findVehicleByVin(
  vin: string,
  shopId?: string | number,
): Promise<Document | null> {
  if (isLegacyVehiclesPgCanonical()) {
    return (await pg.findVehicleByVin(vin, shopId)) as Document | null;
  }
  const col = await collection();
  const filter: Filter<VehicleDoc> = { vin };
  if (shopId !== undefined) {
    (filter as Record<string, unknown>).shopId = {
      $in: [String(shopId), Number(shopId)],
    };
  }
  return col.findOne(filter);
}

/**
 * Upsert a vehicle keyed on (shopId, vin) and return the resulting doc.
 * Mirrors the `findOneAndUpdate({ shopId, vin }, ..., { upsert: true,
 * returnDocument: "after" })` in lib/models/customers.ts. `setOnInsert`
 * fields are applied only when the row is newly created; `set` fields
 * always apply.
 */
export async function upsertVehicleByShopVin(
  shopId: number | string,
  vin: string,
  setOnInsert: Record<string, unknown>,
  set: Record<string, unknown>,
): Promise<Document | null> {
  if (isLegacyVehiclesPgCanonical()) {
    const existing = await pg.findVehicleByVin(vin, shopId);
    const merged = existing
      ? { ...existing, ...set }
      : { ...setOnInsert, ...set };
    await pg.upsertVehicleSnapshot(shopId, vin, merged);
    if (shouldShadowWriteMongoLegacyVehicles()) {
      await shadowWriteMongoLegacyStore("vehicles.upsertByShopVin", async () => {
        const col = await collection();
        await col.updateOne(
          { shopId, vin } as Filter<VehicleDoc>,
          { $setOnInsert: setOnInsert, $set: set } as UpdateFilter<VehicleDoc>,
          { upsert: true },
        );
      });
    }
    return (await pg.findVehicleByVin(vin, shopId)) as Document | null;
  }
  const col = await collection();
  const res = await col.findOneAndUpdate(
    { shopId, vin } as Filter<VehicleDoc>,
    { $setOnInsert: setOnInsert, $set: set } as UpdateFilter<VehicleDoc>,
    { upsert: true, returnDocument: "after" },
  );
  return (res && (res as { value?: Document }).value) ?? (res as Document | null);
}

export async function findVehicleByProtractorWorkOrder(
  shopId: number | string,
  workOrderId: string,
): Promise<Document | null> {
  if (isLegacyVehiclesPgCanonical()) {
    const pgMatch = (await pg.findVehicleByProtractorWorkOrder(
      shopId,
      workOrderId,
    )) as Document | null;
    const mongoMatch = await findVehicleByProtractorWorkOrderMongo(shopId, workOrderId);
    if (!pgMatch && !mongoMatch) return null;
    return {
      ...(pgMatch || mongoMatch)!,
      ...(pgMatch ? { __pgTerminalMatch: pgMatch } : {}),
      ...(mongoMatch ? { __mongoTerminalMatch: mongoMatch } : {}),
    } as TerminalVehicleMatch;
  }
  return findVehicleByProtractorWorkOrderMongo(shopId, workOrderId);
}

async function findVehicleByProtractorWorkOrderMongo(
  shopId: number | string,
  workOrderId: string,
): Promise<Document | null> {
  const col = await collection();
  return col.findOne({
    shopId: { $in: [String(shopId), Number(shopId)] },
    "status.sources": {
      $elemMatch: { provider: "protractor", workOrderId: String(workOrderId) },
    },
  } as Filter<VehicleDoc>);
}

export async function removeProtractorWorkOrderSource(
  vehicle: Document,
  shopId: number | string,
  workOrderId: string,
  now: Date,
): Promise<void> {
  const terminalSet = (matched: Document) => {
    const sources = Array.isArray(matched.status?.sources)
      ? matched.status.sources.filter(
        (source: any) =>
          !(source?.provider === "protractor" &&
            String(source?.workOrderId) === String(workOrderId)),
      )
      : [];
    return {
      status: {
        ...(matched.status || {}),
        sources,
        active: sources.length > 0,
        ...(sources.length ? {} : { lastClosedAt: now }),
      },
      updatedAt: now,
    };
  };
  if (isLegacyVehiclesPgCanonical()) {
    const match = vehicle as TerminalVehicleMatch;
    if (match.__pgTerminalMatch) {
      const vin = typeof match.__pgTerminalMatch.vin === "string"
        ? match.__pgTerminalMatch.vin
        : "";
      if (!vin) throw new Error("Protractor PG vehicle reference has no VIN");
      await pg.upsertVehicleSnapshot(
        shopId,
        vin,
        { ...match.__pgTerminalMatch, ...terminalSet(match.__pgTerminalMatch) },
      );
    }
    if (match.__mongoTerminalMatch) {
      await removeProtractorWorkOrderSourceMongo(
        match.__mongoTerminalMatch,
        shopId,
        terminalSet(match.__mongoTerminalMatch),
      );
    }
    if (!match.__pgTerminalMatch && !match.__mongoTerminalMatch) {
      throw new Error("Protractor vehicle has no routed terminal match");
    }
    return;
  }
  await removeProtractorWorkOrderSourceMongo(vehicle, shopId, terminalSet(vehicle));
}

async function removeProtractorWorkOrderSourceMongo(
  vehicle: Document,
  shopId: number | string,
  set: Document,
): Promise<void> {
  if (!vehicle._id) throw new Error("Protractor vehicle reference has no Mongo identity");
  const col = await collection();
  const result = await col.updateOne(
    {
      _id: vehicle._id,
      shopId: { $in: [String(shopId), Number(shopId)] },
    } as Filter<VehicleDoc>,
    { $set: set } as UpdateFilter<VehicleDoc>,
  );
  if (result.matchedCount !== 1) {
    throw new Error("Protractor vehicle reference disappeared before terminal update");
  }
}

/* ------------------------------- manual_vehicles -------------------------- */

async function manualCollection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(MANUAL_COLLECTION);
}

/**
 * Find an active (non-archived) manual vehicle for a shop + VIN.
 */
export async function findActiveManualVehicle(
  shopId: number,
  vin: string,
): Promise<Document | null> {
  if (isLegacyVehiclesPgCanonical()) {
    return (await pg.findActiveManualVehicle(shopId, vin)) as Document | null;
  }
  const col = await manualCollection();
  return col.findOne({ shopId, vin, archived: { $ne: true } });
}

/**
 * Insert or update a manual vehicle keyed on (shopId, vin). Callers pass
 * the full doc they want persisted (the `archived`, `customerName`,
 * `roNumber`, `mileage`, … fields all survive in the PG payload).
 */
export async function upsertManualVehicle(
  shopId: number,
  vin: string,
  fullDoc: Document,
): Promise<void> {
  if (isLegacyVehiclesPgCanonical()) {
    await pg.upsertManualVehicle(shopId, vin, fullDoc as Record<string, unknown>);
    if (shouldShadowWriteMongoLegacyVehicles()) {
      await shadowWriteMongoLegacyStore("manual_vehicles.upsert", async () => {
        const col = await manualCollection();
        await col.updateOne(
          { shopId, vin },
          { $set: fullDoc },
          { upsert: true },
        );
      });
    }
    return;
  }
  const col = await manualCollection();
  await col.updateOne({ shopId, vin }, { $set: fullDoc }, { upsert: true });
}

/**
 * Update an existing manual vehicle by its Mongo `_id` (or PG row). Used by
 * the manual-vehicle CRUD route when a matching active row already exists.
 * `existing` is the doc returned by `findActiveManualVehicle`.
 */
export async function updateManualVehicle(
  shopId: number,
  vin: string,
  existing: Document,
  set: Document,
): Promise<void> {
  if (isLegacyVehiclesPgCanonical()) {
    await pg.upsertManualVehicle(shopId, vin, { ...existing, ...set });
    if (shouldShadowWriteMongoLegacyVehicles()) {
      await shadowWriteMongoLegacyStore("manual_vehicles.update", async () => {
        const col = await manualCollection();
        const idFilter = (existing as { _id?: unknown })._id
          ? { _id: (existing as { _id?: unknown })._id }
          : { shopId, vin };
        await col.updateOne(idFilter as Filter<Document>, { $set: set });
      });
    }
    return;
  }
  const col = await manualCollection();
  const idFilter = (existing as { _id?: unknown })._id
    ? { _id: (existing as { _id?: unknown })._id }
    : { shopId, vin };
  await col.updateOne(idFilter as Filter<Document>, { $set: set });
}

/**
 * Soft-delete (archive) a manual vehicle for a shop + VIN.
 */
export async function archiveManualVehicle(
  shopId: number,
  vin: string,
): Promise<void> {
  if (isLegacyVehiclesPgCanonical()) {
    await pg.archiveManualVehicle(shopId, vin);
    if (shouldShadowWriteMongoLegacyVehicles()) {
      await shadowWriteMongoLegacyStore("manual_vehicles.archive", async () => {
        const col = await manualCollection();
        await col.updateOne(
          { shopId, vin },
          { $set: { archived: true, updatedAt: new Date() } },
        );
      });
    }
    return;
  }
  const col = await manualCollection();
  await col.updateOne(
    { shopId, vin },
    { $set: { archived: true, updatedAt: new Date() } },
  );
}
