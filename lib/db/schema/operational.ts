/**
 * Operational primitives (task #557) — Postgres destination tables for the
 * two cross-process coordination stores that still live in Mongo:
 *
 *   - `cron_locks`            — the in-process cron scheduler's distributed
 *                               lock (TTL-takeover, instance-fenced release).
 *                               Mongo home: db `mos`, collection `cron_locks`.
 *   - `tekmetric_rate_buckets`— the shared per-second token bucket for the
 *                               cross-process Tekmetric rate limiter.
 *                               Mongo home: collection `tekmetric_rate_buckets`.
 *
 * **Schema-only + flag-gated.** These tables are the destination for the
 * operational-primitives cutover. The runtime code (`lib/cron/scheduler.cjs`
 * and `lib/integrations/tekmetric/shared-rate-limiter.ts`) reads/writes them
 * ONLY when the per-primitive canonical flag is set
 * (`CRON_LOCK_PG_CANONICAL=1`, `TEKMETRIC_SHARED_LIMITER_PG_CANONICAL=1`);
 * default-off keeps the current Mongo behavior. Neither store carries
 * historical data worth backfilling — locks and per-second buckets are
 * ephemeral and self-heal within their TTL — so the cutover is a flag flip
 * with no backfill/soak. See docs/db-migration-map.md §12.
 *
 * Conventions carried over from wave1/wave2:
 *   - Natural keys are the primary key (`job_name`, `bucket_key`).
 *   - All timestamps are `timestamptz`.
 *   - Postgres has no Mongo-style TTL index, so expiry is enforced in the
 *     acquire query (`expires_at <= now()` gates takeover) plus opportunistic
 *     best-effort `DELETE ... WHERE expires_at <= now()` sweeps in code. The
 *     `expires_at` indexes below keep those sweeps cheap.
 */
import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * `cron_locks` — one row per cron job name. A row's presence with
 * `expires_at > now()` means some instance currently holds the job's lock.
 * Acquire is an atomic `INSERT ... ON CONFLICT DO UPDATE` that only takes
 * over when the existing lease is expired (or already held by the same
 * instance, which simply refreshes the TTL). Release is fenced on
 * `instance_id` so a slow instance cannot delete a successor's lock.
 */
export const cronLocks = pgTable(
  "cron_locks",
  {
    jobName: text("job_name").primaryKey(),
    lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    instanceId: text("instance_id").notNull(),
  },
  (t) => ({
    expiresIdx: index("cron_locks_expires_at_idx").on(t.expiresAt),
  }),
);

/**
 * `tekmetric_rate_buckets` — one row per wall-clock second
 * (`bucket_key = "tek:<unix-second>"`). Each acquire atomically increments
 * `count`; the whole budget renews each second, so there is no refill math.
 * `expires_at` (~10s out) marks the row as sweepable.
 */
export const tekmetricRateBuckets = pgTable(
  "tekmetric_rate_buckets",
  {
    bucketKey: text("bucket_key").primaryKey(),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index("tekmetric_rate_buckets_expires_at_idx").on(t.expiresAt),
  }),
);
