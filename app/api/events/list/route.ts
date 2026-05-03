import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listRecentEvents } from "@/lib/data/repositories/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sess = await getSession(req);
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { user } = sess;

  const limit = clampInt(req.nextUrl.searchParams.get("limit"), 50, 1, 200);

  const docs = await listRecentEvents(
    { shopId: user.shopId },
    {
      limit,
      projection: {
        _id: 1,
        provider: 1,
        event: 1,
        payload: 1,
        receivedAt: 1,
      },
    },
  );

  return NextResponse.json({ ok: true, items: docs });
}

function clampInt(val: string | null, def: number, min: number, max: number) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
