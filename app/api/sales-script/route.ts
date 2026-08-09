// Dashboard Sales Coach API (task #987): open estimates + AI sales scripts.
//
// Auth: shop-user session; all reads are scoped to session.shopId — the
// client never supplies a shop id.
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listOpenEstimates, getOrGenerateScript } from "@/lib/sales-coach/script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.shopId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const shopId = Number(session.shopId);
  if (!Number.isFinite(shopId)) {
    return NextResponse.json({ ok: false, error: "No shop context" }, { status: 400 });
  }

  const workOrderId = req.nextUrl.searchParams.get("workOrderId");
  try {
    if (workOrderId) {
      const result = await getOrGenerateScript(shopId, workOrderId);
      if (!result) {
        return NextResponse.json(
          { ok: false, error: "Work order not found for this shop or has no sellable jobs" },
          { status: 404 },
        );
      }
      return NextResponse.json({ ok: true, ...result });
    }
    const estimates = await listOpenEstimates(shopId);
    return NextResponse.json({ ok: true, estimates });
  } catch (err: any) {
    console.error(`[SalesScript] ${err?.message || err}`);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
