import sql from "@/lib/db/postgres";

export type RateResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
  bucketKey: string;
};

export async function rateLimit(opts: {
  id: string;
  limit: number;
  windowSeconds: number;
}): Promise<RateResult> {
  const { id, limit, windowSeconds } = opts;

  const nowMs = Date.now();
  const bucket = Math.floor(nowMs / (windowSeconds * 1000));
  const bucketKey = `${id}:${bucket}`;
  const resetAt = new Date((bucket + 1) * windowSeconds * 1000);
  const expiresAt = new Date(resetAt.getTime() + 5000);

  await sql`DELETE FROM ratelimits WHERE expires_at < NOW()`;

  const result = await sql`
    INSERT INTO ratelimits (bucket_key, count, window_seconds, expires_at)
    VALUES (${bucketKey}, 1, ${windowSeconds}, ${expiresAt})
    ON CONFLICT (bucket_key) DO UPDATE SET
      count = ratelimits.count + 1
    RETURNING count
  `;

  const count = result[0]?.count ?? 1;

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    limit,
    resetAt,
    bucketKey,
  };
}

export function clientIp(req: Request): string {
  const xff = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return xff || "unknown";
}
