// app/api/events/autoflow/recent/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { listRecentEvents } from "@/lib/data/repositories/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const sess = await requireSession();
  const { searchParams } = new URL(req.url);

  let limit = Number(searchParams.get("limit"));
  if (!Number.isFinite(limit)) limit = 25;
  limit = Math.max(1, Math.min(200, Math.floor(limit)));

  const token = searchParams.get("token") || undefined;
  const sinceParam = searchParams.get("since");
  const ignoreShopId =
    searchParams.get("ignoreShopId") === "1" ||
    searchParams.get("scope") === "tokenOnly";

  const shopIdParam = searchParams.get("shopId");
  const shopId =
    shopIdParam !== null
      ? (isNaN(Number(shopIdParam)) ? shopIdParam : Number(shopIdParam))
      : sess.shopId;

  const query: Record<string, any> = { provider: "autoflow" };
  if (token) query.token = token;
  if (!ignoreShopId && shopId !== undefined && shopId !== null && shopId !== "")
    query.shopId = shopId;

  if (sinceParam) {
    const since = new Date(sinceParam);
    if (!isNaN(since.getTime())) query.receivedAt = { $gte: since };
  }

  const logs = await listRecentEvents(query, {
    limit,
    projection: {
      _id: 0,
      receivedAt: 1,
      token: 1,
      payload: 1,
      raw: 1,
    },
  });

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
