import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = clampInt(req.nextUrl.searchParams.get("limit"), 50, 1, 200);
  const shopId = String(sess.shopId);

  const docs = await sql`
    SELECT id, provider, event, payload, received_at
    FROM events
    WHERE shop_id = ${shopId}
    ORDER BY received_at DESC
    LIMIT ${limit}
  `;

  const items = docs.map(doc => ({
    _id: doc.id,
    provider: doc.provider,
    event: doc.event,
    payload: doc.payload,
    receivedAt: doc.received_at,
  }));

  return NextResponse.json({ ok: true, items });
}

function clampInt(val: string | null, def: number, min: number, max: number) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
