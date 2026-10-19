import type { MongoClient, Db } from "mongodb";
import type { Store, Transaction } from "@/lib/auto-dvi/durable/repository";

export const DURABLE_COLLECTION = "auto_dvi_durable_v1";
/** Provisioning is intentionally NOT done here. Operator must pre-create the
 * collection on a transaction-capable replica set. All natural-key uniqueness
 * uses Mongo's mandatory _id index, with separate prefixes in one authority. */
export class MongoDviStore implements Store {
  constructor(private client: MongoClient, private db: Db) {}
  async ready() {
    const exists = await this.db.listCollections({name: DURABLE_COLLECTION}, {nameOnly: true}).hasNext();
    if (!exists) throw new Error("Durable DVI storage not provisioned");
    if (!await this.db.listCollections({name: "auto_dvi_applications"}, {nameOnly: true}).hasNext())
      throw new Error("Durable DVI activity storage not provisioned");
    const indexes = await this.db.collection(DURABLE_COLLECTION).listIndexes().toArray();
    if (!indexes.some(i => i.name === "_id_" && i.key?._id === 1) || indexes.some(i => i.expireAfterSeconds !== undefined))
      throw new Error("Durable DVI constraints not verified");
    const hello = await this.db.admin().command({hello: 1});
    if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("Transactions required");
  }
  async read<T>(key: string): Promise<T | null> {
    const row = await this.db.collection(DURABLE_COLLECTION).findOne({_id: key} as any,
      {readConcern: {level: "majority"}, readPreference: "primary"});
    return row ? row.value as T : null;
  }
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      const result = await session.withTransaction(async () => fn({
        get: async <V>(key: string) => {
          const row = await this.db.collection(DURABLE_COLLECTION).findOne({_id: key} as any, {session});
          return row ? row.value as V : null;
        },
        put: async <V>(key: string, value: V) => {
          if (key.startsWith("activity:")) {
            // Same event identity and transaction as outbox delivery.
            await this.db.collection("auto_dvi_applications").updateOne({_id: key} as any,
              {$setOnInsert: value as any}, {upsert: true, session});
          } else {
            await this.db.collection(DURABLE_COLLECTION).replaceOne({_id: key} as any,
              {_id: key, value} as any, {upsert: true, session});
          }
        },
      }), {readConcern: {level: "snapshot"}, writeConcern: {w: "majority", j: true}, readPreference: "primary"});
      return result as T;
    } finally { await session.endSession(); }
  }
}
