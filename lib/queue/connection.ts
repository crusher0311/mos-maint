/**
 * Redis connection for the BullMQ-backed worker queue (task #513).
 *
 * Lazy and optional: callers MUST check `getRedisConnection()` for null
 * before assuming a queue is available. When `REDIS_URL` is not set, the
 * whole queue subsystem is treated as not-installed and every producer
 * falls back to the legacy in-process backfill path. That means this
 * file is safe to land in production before Redis has actually been
 * provisioned — feature flag gating in `lib/queue/feature-flag.ts` keeps
 * the dormant path from ever calling into BullMQ.
 *
 * Why a singleton: BullMQ creates its own Worker/QueueEvents connections
 * internally, but every Queue producer in the web service shares this
 * one connection. ioredis multiplexes commands over a single TCP socket,
 * so one connection per process is the standard pattern.
 *
 * Why `maxRetriesPerRequest: null`: BullMQ's blocking commands (BRPOPLPUSH)
 * require unbounded retries; setting a finite value crashes the worker
 * on transient Redis reconnects. The Redis maintainers documented this
 * explicitly in the BullMQ README — do not "fix" it.
 */

import type { Redis } from "ioredis";

let connection: Redis | null = null;
let attempted = false;

export function isQueueEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}

export function getRedisConnection(): Redis | null {
  if (!isQueueEnabled()) return null;
  if (connection) return connection;
  if (attempted) return connection;
  attempted = true;

  try {
    // Require lazily so test environments / dev sandboxes that never
    // import the queue layer don't pay the ioredis startup cost.
    const IORedis = require("ioredis") as typeof import("ioredis");
    connection = new IORedis.default(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    connection.on("error", (err) => {
      // Don't crash the web service if Redis blips — BullMQ recovers on
      // reconnect, producers fall back to a fail-closed enqueue (see
      // `producer.ts`).
      console.warn(
        `[Queue Connection] Redis error: ${err?.message || err}`,
      );
    });
    connection.on("ready", () => {
      console.log("[Queue Connection] Redis ready");
    });
  } catch (err: any) {
    console.error(
      `[Queue Connection] Failed to construct Redis client: ${err?.message || err}`,
    );
    connection = null;
  }
  return connection;
}

/** Test-only seam. */
export function __resetConnectionForTest(): void {
  if (connection) {
    try {
      connection.disconnect();
    } catch {}
  }
  connection = null;
  attempted = false;
}
