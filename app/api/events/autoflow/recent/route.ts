// app/api/events/autoflow/recent/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  // Only signed-in users can view logs
  const sess = await requireSession();

  const db = await getDb();
  const { searchParams } = new URL(req.url);

  // limit (default 25, clamp 1..200)
  let limit = Number(searchParams.get("limit"));
  if (!Number.isFinite(limit)) limit = 25;
  limit = Math.max(1, Math.min(200, Math.floor(limit)));

  // optional filters
  const token = searchParams.get("token") || undefined;
  const sinceParam = searchParams.get("since"); // ISO string
  const ignoreShopId =
    searchParams.get("ignoreShopId") === "1" ||
    searchParams.get("scope") === "tokenOnly";

  // choose shopId filter (default to session)
  const shopIdParam = searchParams.get("shopId");
  const shopId =
    shopIdParam !== null
      ? (isNaN(Number(shopIdParam)) ? shopIdParam : Number(shopIdParam))
      : sess.shopId;

  // build query
  const query: Record<string, any> = { provider: "autoflow" };
  if (token) query.token = token;
  if (!ignoreShopId && shopId !== undefined && shopId !== null && shopId !== "")
    query.shopId = shopId;

  if (sinceParam) {
    const since = new Date(sinceParam);
    if (!isNaN(since.getTime())) query.receivedAt = { $gte: since };
  }

  const logs = await db
    .collection("events")
    .find(query)
    .sort({ receivedAt: -1 })
    .limit(limit)
    .project({
      _id: 0,
      receivedAt: 1,
      token: 1,
      payload: 1,
      raw: 1,
    })
    .toArray();

  return NextResponse.json(
    { ok: true, count: logs.length, logs },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
        Pragma: "no-cache",
      },
    }
  );
}


