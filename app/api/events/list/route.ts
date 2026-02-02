import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sess = await getSession(req);
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { user } = sess;
  // If you want owner-only, uncomment:
  // if (user.role !== "owner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const limit = clampInt(req.nextUrl.searchParams.get("limit"), 50, 1, 200);

  const db = await getDb();
  const events = db.collection("events");

  const docs = await events
    .find({ shopId: user.shopId })
    .sort({ receivedAt: -1 })
    .limit(limit)
    .project({
      _id: 1,
      provider: 1,
      event: 1,
      payload: 1,
      receivedAt: 1,
    })
    .toArray();

  return NextResponse.json({ ok: true, items: docs });
}

function clampInt(val: string | null, def: number, min: number, max: number) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

