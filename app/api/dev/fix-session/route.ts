import { NextResponse, NextRequest } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { updateSessionByToken } from "@/lib/data/repositories/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Dev only" }, { status: 403 });
  }

  const newShopId = req.nextUrl.searchParams.get("newShopId");
  if (!newShopId) {
    return NextResponse.json({ error: "newShopId required" }, { status: 400 });
  }

  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "No session" }, { status: 401 });
  }

  const result = await updateSessionByToken(token, {
    $set: { shopId: Number(newShopId) },
  });

  return NextResponse.json({
    ok: true,
    modified: result.modifiedCount,
    newShopId: Number(newShopId),
  });
}
