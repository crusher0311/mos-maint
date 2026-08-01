// Repository for the `protractor_webhook_subscriptions` collection —
// per-shop callback registration bookkeeping.
//
// Task #999: writes dispatch to Postgres when
// `PROTRACTOR_OPS_PG_CANONICAL=1`, with a Mongo shadow write during the
// soak window (`WRITE_MONGO_PROTRACTOR_OPS`). Default flag OFF keeps
// Mongo canonical — byte-identical to prior behavior.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isProtractorOpsPgCanonical,
  shouldShadowWriteMongoProtractorOps,
  shadowWriteMongoIntegrationOps,
} from "@/lib/db/integration-ops-write-mode";
import * as pg from "./pg/protractor-webhook-subscriptions";

const COLLECTION = "protractor_webhook_subscriptions";

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

export interface EnsureSubscriptionFields {
  token: string | null;
  callbackUrl: string | null;
  registrationMode: string;
  lastEnsuredAt: Date;
  firstEnsuredAt: Date;
}

export async function ensureSubscriptionRecord(
  shopId: number,
  fields: EnsureSubscriptionFields,
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.ensureSubscriptionRecord(shopId, fields);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.webhook_subscriptions.ensure",
      () => ensureSubscriptionRecordMongo(shopId, fields),
    );
    return;
  }
  await ensureSubscriptionRecordMongo(shopId, fields);
}

async function ensureSubscriptionRecordMongo(
  shopId: number,
  fields: EnsureSubscriptionFields,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId },
    {
      $set: {
        shopId,
        token: fields.token,
        callbackUrl: fields.callbackUrl,
        registrationMode: fields.registrationMode,
        lastEnsuredAt: fields.lastEnsuredAt,
      },
      $setOnInsert: { firstEnsuredAt: fields.firstEnsuredAt },
    },
    { upsert: true },
  );
}
