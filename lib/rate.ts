// lib/rate.ts
import { getDb } from "@/lib/mongo";

export type RateResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
  bucketKey: string;
};

/**
 * Mongo rate limiter using time-bucket documents.
 * - Keyed by a stable id (e.g., route + IP + emailLower).
 * - One document per window bucket, TTL-managed by an index.
 */
export async function rateLimit(opts: {
  id: string;          // e.g. "login:1.2.3.4:email@x.com:shop7"
  limit: number;       // max requests per window
  windowSeconds: number;
}): Promise<RateResult> {
  const { id, limit, windowSeconds } = opts;
  const db = await getDb();
  const col = db.collection("ratelimits");

  const nowMs = Date.now();
  const bucket = Math.floor(nowMs / (windowSeconds * 1000));
  const bucketKey = `${id}:${bucket}`;
  const resetAt = new Date((bucket + 1) * windowSeconds * 1000);
  // small buffer so the doc disappears shortly after the window ends
  const expiresAt = new Date(resetAt.getTime() + 5000);

  // IMPORTANT: do NOT $setOnInsert `count`. Let $inc create it as 1.
  const result = await col.findOneAndUpdate(
    { bucketKey },
    {
      $inc: { count: 1 },
      $setOnInsert: {
        bucketKey,
        windowSeconds,
        createdAt: new Date(),
        expiresAt,
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  const doc: any = (result as any)?.value ?? (result as any);
  const count = typeof doc?.count === "number" ? doc.count : 1;

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

