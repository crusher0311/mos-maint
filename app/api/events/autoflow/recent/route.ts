import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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
  const shopId = shopIdParam !== null ? String(shopIdParam) : String(sess.shopId);

  const sinceParsed = sinceParam ? new Date(sinceParam) : null;
  const validSince = sinceParsed && !isNaN(sinceParsed.getTime()) ? sinceParsed : null;

  let logs;
  
  if (token && !ignoreShopId && validSince) {
    logs = await sql`
      SELECT received_at, token, payload, raw
      FROM events
      WHERE provider = 'autoflow' AND token = ${token} AND shop_id = ${shopId} AND received_at >= ${validSince}
      ORDER BY received_at DESC
      LIMIT ${limit}
    `;
  } else if (token && !ignoreShopId) {
    logs = await sql`
      SELECT received_at, token, payload, raw
      FROM events
      WHERE provider = 'autoflow' AND token = ${token} AND shop_id = ${shopId}
      ORDER BY received_at DESC
      LIMIT ${limit}
    `;
  } else if (token && validSince) {
    logs = await sql`
      SELECT received_at, token, payload, raw
      FROM events
      WHERE provider = 'autoflow' AND token = ${token} AND received_at >= ${validSince}
      ORDER BY received_at DESC
      LIMIT ${limit}
    `;
  } else if (token) {
    logs = await sql`
      SELECT received_at, token, payload, raw
      FROM events
      WHERE provider = 'autoflow' AND token = ${token}
      ORDER BY received_at DESC
      LIMIT ${limit}
    `;
  } else if (!ignoreShopId && validSince) {
    logs = await sql`
      SELECT received_at, token, payload, raw
      FROM events
      WHERE provider = 'autoflow' AND shop_id = ${shopId} AND received_at >= ${validSince}
      ORDER BY received_at DESC
      LIMIT ${limit}
    `;
  } else if (!ignoreShopId) {
    logs = await sql`
      SELECT received_at, token, payload, raw
      FROM events
      WHERE provider = 'autoflow' AND shop_id = ${shopId}
      ORDER BY received_at DESC
      LIMIT ${limit}
    `;
  } else if (validSince) {
    logs = await sql`
      SELECT received_at, token, payload, raw
      FROM events
      WHERE provider = 'autoflow' AND received_at >= ${validSince}
      ORDER BY received_at DESC
      LIMIT ${limit}
    `;
  } else {
    logs = await sql`
      SELECT received_at, token, payload, raw
      FROM events
      WHERE provider = 'autoflow'
      ORDER BY received_at DESC
      LIMIT ${limit}
    `;
  }

  const formattedLogs = logs.map(log => ({
    receivedAt: log.received_at,
    token: log.token,
    payload: log.payload,
    raw: log.raw,
  }));

  return NextResponse.json(
    { ok: true, count: formattedLogs.length, logs: formattedLogs },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
        Pragma: "no-cache",
      },
    }
  );
}
