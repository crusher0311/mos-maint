import { createHash } from "node:crypto";
import { getDb } from "@/lib/data/db";

const COLLECTION = "protractor_callback_quarantine";

export type UnknownCallbackMethod = "GET" | "POST";

export function fingerprintProtractorConnection(connectionId: string): string {
  return createHash("sha256").update(connectionId).digest("hex").slice(0, 24);
}

/**
 * Privacy-safe quarantine counter for callbacks whose connection id does not
 * map to a shop.  The raw id and payload are intentionally never persisted or
 * logged. Daily buckets keep the collection bounded and useful for alerting.
 */
export async function recordUnknownCallback(fields: {
  method: UnknownCallbackMethod;
  sourceRoute: string;
  connectionId: string;
  now?: Date;
}): Promise<void> {
  const now = fields.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const connectionFingerprint = fingerprintProtractorConnection(fields.connectionId);
  const telemetry = {
    event: "protractor_unknown_callback",
    sourceRoute: fields.sourceRoute,
    method: fields.method,
    connectionFingerprint,
  } as const;

  console.warn(JSON.stringify(telemetry));
  const db = await getDb();
  await db.collection(COLLECTION).updateOne(
    {
      _id: `${day}:${fields.method}:${connectionFingerprint}`,
    } as any,
    {
      $setOnInsert: {
        day,
        sourceRoute: fields.sourceRoute,
        method: fields.method,
        connectionFingerprint,
        firstSeenAt: now,
      },
      $set: { lastSeenAt: now },
      $inc: { count: 1 },
    },
    { upsert: true },
  );
}