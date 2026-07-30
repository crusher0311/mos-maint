/**
 * Task #966 — single-flight initial-sync lock semantics.
 *
 * Runs against an in-memory fake Mongo collection (never the real DB —
 * dev Mongo IS prod here). Verifies:
 *   1. first acquire wins;
 *   2. overlapping acquire is rejected while the lock is live;
 *   3. owner-scoped release frees the lock for the next trigger;
 *   4. a TTL-expired lock is taken over;
 *   5. a stale release (old owner) does NOT clear a re-acquired lock.
 */
import {
  acquireInitialSyncLock,
  releaseInitialSyncLock,
} from "../lib/integrations/tekmetric/initial-sync-lock";

type Doc = Record<string, any>;

function makeFakeDb() {
  const store = new Map<any, Doc>();
  const matches = (doc: Doc, filter: Doc): boolean => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === "$or") {
        if (!(v as Doc[]).some((sub) => matches(doc, sub))) return false;
        continue;
      }
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("$exists" in v) {
          const has = doc[k] !== undefined;
          if (has !== v.$exists) return false;
          continue;
        }
        if ("$lte" in v) {
          if (!(doc[k] instanceof Date) || doc[k].getTime() > v.$lte.getTime())
            return false;
          continue;
        }
      }
      if (k === "_id") {
        if (doc._id !== v) return false;
        continue;
      }
      if (doc[k] !== v) return false;
    }
    return true;
  };
  const collection = {
    async findOneAndUpdate(filter: Doc, update: Doc, _opts: Doc) {
      for (const doc of store.values()) {
        if (matches(doc, filter)) {
          Object.assign(doc, update.$set);
          return { value: doc };
        }
      }
      return { value: null };
    },
    async findOne(filter: Doc) {
      for (const doc of store.values()) if (matches(doc, filter)) return doc;
      return null;
    },
    async insertOne(doc: Doc) {
      if (store.has(doc._id)) {
        const err: any = new Error("E11000 duplicate key");
        err.code = 11000;
        throw err;
      }
      store.set(doc._id, { ...doc });
    },
    async deleteOne(filter: Doc) {
      for (const [id, doc] of store.entries()) {
        if (matches(doc, filter)) {
          store.delete(id);
          return { deletedCount: 1 };
        }
      }
      return { deletedCount: 0 };
    },
  };
  return { collection: () => collection, _store: store };
}

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok — ${msg}`);
}

async function main() {
  const db = makeFakeDb();
  const SHOP = 999001;

  // 1. first acquire wins (insert path)
  const a = await acquireInitialSyncLock(db, SHOP);
  assert(a.acquired === true, "first acquire wins");
  const ownerA = (a as any).owner;

  // 2. overlapping acquire rejected
  const b = await acquireInitialSyncLock(db, SHOP);
  assert(b.acquired === false, "second acquire is a no-op while in flight");
  assert(
    (b as any).heldBy === ownerA,
    "busy result reports the in-flight owner",
  );

  // 3. owner-scoped release frees it
  await releaseInitialSyncLock(db, SHOP, ownerA);
  const c = await acquireInitialSyncLock(db, SHOP);
  assert(c.acquired === true, "acquire succeeds after owner release");
  const ownerC = (c as any).owner;

  // 4. TTL-expired lock is taken over (simulate expiry)
  const doc = db._store.get(SHOP)!;
  doc.expiresAt = new Date(Date.now() - 1000);
  const d = await acquireInitialSyncLock(db, SHOP);
  assert(d.acquired === true, "TTL-expired lock is taken over");
  assert((d as any).owner !== ownerC, "takeover installs a new owner");

  // 5. stale release by old owner does not clear the new lock
  await releaseInitialSyncLock(db, SHOP, ownerC);
  const e = await acquireInitialSyncLock(db, SHOP);
  assert(
    e.acquired === false,
    "stale release (old owner) cannot clear a re-acquired lock",
  );

  console.log("All initial-sync lock assertions passed.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
