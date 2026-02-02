// lib/ids.ts
import { getDb } from "@/lib/mongo";

/**
 * Atomically increments and returns the next numeric shopId (1,2,3,...).
 * - First ensures the counter exists with seq: 0
 * - Then increments with a pure $inc (no $setOnInsert on the same field)
 * - Works with both returnDocument:"after" and returnOriginal:false
 */
export async function getNextShopId(): Promise<number> {
  const db = await getDb();
  const counters = db.collection("counters");

  // Ensure the counter doc exists; seed seq at 0 so first next = 1
  await counters.updateOne(
    { _id: "shopId" },
    { $setOnInsert: { _id: "shopId", seq: 0 } },
    { upsert: true }
  );

  // Try (v4+) returnDocument: "after"
  let res: any = await counters.findOneAndUpdate(
    { _id: "shopId" },
    { $inc: { seq: 1 } },               // <-- no $setOnInsert here (avoids conflict)
    { upsert: true, returnDocument: "after" as any }
  );
  let seq: any = res?.value?.seq;

  // Fallback (v3.x) returnOriginal: false
  if (!Number.isFinite(seq)) {
    res = await (counters as any).findOneAndUpdate(
      { _id: "shopId" },
      { $inc: { seq: 1 } },
      { upsert: true, returnOriginal: false }
    );
    seq = res?.value?.seq;
  }

  // Last resort: two-step (still atomic on $inc)
  if (!Number.isFinite(seq)) {
    await counters.updateOne({ _id: "shopId" }, { $inc: { seq: 1 } }, { upsert: true });
    const doc = await counters.findOne({ _id: "shopId" });
    seq = doc?.seq;
  }

  if (!Number.isFinite(seq)) {
    throw new Error("Counter not initialized correctly");
  }
  return seq as number;
}

