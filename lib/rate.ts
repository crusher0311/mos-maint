// lib/rate.ts
//
// Wave 1 cutover (task #342): the rate limiter is now backed by Postgres.
// We keep a best-effort mirror write into Mongo `ratelimits` so the legacy
// collection stays current during the soak window, but the authoritative
// counter — and the one we use to decide allow/deny — comes from PG.
import { getDb } from "@/lib/mongo";
import { pgRateLimit } from "@/lib/db/repositories/wave1";

export type RateResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
  bucketKey: string;
};

export async function rateLimit(opts: {
  id: string;          // e.g. "login:1.2.3.4:email@x.com:shop7"
  limit: number;       // max requests per window
  windowSeconds: number;
}): Promise<RateResult> {
  const { id, limit, windowSeconds } = opts;
  const nowMs = Date.now();
  const bucket = Math.floor(nowMs / (windowSeconds * 1000));
  const bucketKey = `${id}:${bucket}`;
  const resetAt = new Date((bucket + 1) * windowSeconds * 1000);
  const expiresAt = new Date(resetAt.getTime() + 5000);

  // Authoritative counter: Postgres.
  let count = 1;
  let pgSucceeded = false;
  try {
    count = await pgRateLimit({ bucketKey, windowSeconds, expiresAt });
    pgSucceeded = true;
  } catch (err) {
    console.error("[rate] PG counter failed, falling back to Mongo:", err);
    try {
      const db = await getDb();
      type RateDoc = { count?: number };
      const result = await db.collection<RateDoc>("ratelimits").findOneAndUpdate(
        { bucketKey },
        {
          $inc: { count: 1 },
          $setOnInsert: { bucketKey, windowSeconds, createdAt: new Date(), expiresAt },
        },
        { upsert: true, returnDocument: "after" },
      );
      // Driver versions differ: some return the doc directly, some wrap in `.value`.
      const doc =
        (result && typeof result === "object" && "value" in result
          ? (result as { value: RateDoc | null }).value
          : (result as RateDoc | null)) ?? null;
      count = typeof doc?.count === "number" ? doc.count : 1;
    } catch (err2) {
      console.error("[rate] Mongo fallback also failed; failing CLOSED:", err2);
      // Security-sensitive: when both stores are unavailable we DENY the
      // request rather than allow it. This keeps abuse resistance intact
      // for auth/throttle protection at the cost of a transient outage.
      return {
        allowed: false,
        remaining: 0,
        limit,
        resetAt,
        bucketKey,
      };
    }
  }

  // Best-effort mirror to Mongo so the legacy collection still reflects
  // traffic during the soak window. Skip when we already incremented
  // Mongo via the fallback path — otherwise each request would double
  // the counter during a PG outage and trip throttles prematurely.
  if (pgSucceeded) {
    void (async () => {
      try {
        const db = await getDb();
        await db.collection("ratelimits").updateOne(
          { bucketKey },
          {
            $inc: { count: 1 },
            $setOnInsert: { bucketKey, windowSeconds, createdAt: new Date(), expiresAt },
          },
          { upsert: true },
        );
      } catch {
        /* swallow */
      }
    })();
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    limit,
    resetAt,
    bucketKey,
  };
}

// Best-effort client IP extraction behind proxies
export function clientIp(req: Request): string {
  const xff = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return xff || "unknown";
}
