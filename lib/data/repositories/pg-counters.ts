/**
 * Postgres-canonical counter repository (W3b, task #345).
 *
 * Replaces the Mongo `counters` collection (`{ _id, seq }` docs with
 * `$inc: { seq: 1 }`) with `pg_counters` and an atomic
 * `INSERT … ON CONFLICT … DO UPDATE … RETURNING seq` that doubles as
 * the seed-and-increment in one round trip. Monotonicity is preserved
 * by a single-row UPDATE under the row lock the upsert takes.
 *
 * Mongo `counters` is shadow-mirrored during the soak window so the
 * legacy `findOneAndUpdate({ $inc: { seq: 1 } })` writers in the
 * platform-admin / enterprise / admin shop-creation routes still
 * advance their copy in lockstep. After soak, set
 * `WRITE_MONGO_COUNTERS=0` to retire the Mongo mirror.
 */
import { sql } from "drizzle-orm";
import { getDb as getPg } from "@/lib/db/drizzle";
import { getDb as getMongo } from "@/lib/data/db";
import {
  shadowWriteMongo,
  shouldShadowWriteMongoCounters,
} from "@/lib/db/wave3-write-mode";

/**
 * Atomically increment-and-return the named counter. Seeds the row at
 * `seq = 0` on first use; the returned value is always `>= 1`.
 *
 * Optionally pass `floor` to bump the counter forward to at least the
 * given value before incrementing — used by the platform-admin shop
 * creation path to align with `MAX(shopId)` if the legacy Mongo
 * counter falls behind.
 */
export async function nextSeq(
  name: string,
  options: { floor?: number } = {},
): Promise<number> {
  const pg = getPg();
  const floor = options.floor ?? 0;
  // `GREATEST(seq, $floor) + 1` keeps monotonicity even when floor
  // jumps the counter forward.
  const rows = (await pg.execute(sql`
    INSERT INTO pg_counters (name, seq, updated_at)
    VALUES (${name}, GREATEST(${floor}, 0) + 1, now())
    ON CONFLICT (name) DO UPDATE
      SET seq = GREATEST(pg_counters.seq, ${floor}) + 1,
          updated_at = now()
    RETURNING seq
  `)) as unknown as Array<{ seq: string | number }>;
  const seq = Number(rows[0]?.seq);
  if (!Number.isFinite(seq)) {
    throw new Error(`pg_counters: failed to increment ${name}`);
  }

  // Mongo shadow — best effort, never throws. Keeps the legacy
  // `counters` collection in lockstep so any reader still bound to it
  // (or any operator running an ad-hoc query) sees the same number.
  await shadowWriteMongo(
    shouldShadowWriteMongoCounters,
    `counters:${name}`,
    async () => {
      const db = await getMongo();
      // The `counters` collection uses the counter name as its `_id`
      // (a string, not an ObjectId). Mongo's TS shape for `_id` is
      // `ObjectId | <id-overrides>`, so a typed cast through `unknown`
      // is the narrowest annotation that keeps the call type-safe.
      await db.collection<{ _id: string; seq: number }>("counters").updateOne(
        { _id: name },
        { $set: { seq } },
        { upsert: true },
      );
    },
  );

  return seq;
}

/**
 * Read-only inspect; used by admin tooling. Returns 0 if the counter
 * has not been initialized.
 */
export async function peekSeq(name: string): Promise<number> {
  const pg = getPg();
  const rows = (await pg.execute(
    sql`SELECT seq FROM pg_counters WHERE name = ${name}`,
  )) as unknown as Array<{ seq: string | number }>;
  return Number(rows[0]?.seq ?? 0);
}

/**
 * Force the counter forward (e.g. after manual data import). No-op if
 * the counter is already past the requested value.
 */
export async function bumpSeq(name: string, atLeast: number): Promise<number> {
  const pg = getPg();
  const rows = (await pg.execute(sql`
    INSERT INTO pg_counters (name, seq, updated_at)
    VALUES (${name}, ${atLeast}, now())
    ON CONFLICT (name) DO UPDATE
      SET seq = GREATEST(pg_counters.seq, ${atLeast}),
          updated_at = now()
    RETURNING seq
  `)) as unknown as Array<{ seq: string | number }>;
  return Number(rows[0]?.seq ?? atLeast);
}
