import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { searchWorkOrdersForPicker } from "@/lib/data/repositories/normalized-work-orders";

export const dynamic = "force-dynamic";

/**
 * Work order picker for the Estimate Audit tab (Task #833).
 *
 * Lets a service writer search/browse their shop's recent *synced* work
 * orders (by RO number, customer, vehicle, or VIN) instead of typing an RO id
 * blind. Backed by `normalized_work_orders` — the same collection the audit
 * route resolves against — so anything picked here is guaranteed resolvable.
 *
 * Dashboard-session-only: the extension gets RO context from the open page
 * and never needs this route.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 15, 1), 50);

    const workOrders = await searchWorkOrdersForPicker(shopId, q, limit);

    return NextResponse.json({ ok: true, workOrders });
  } catch (error: any) {
    console.error("[Estimate Audit WO Picker] Error:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to search work orders" },
      { status: 500 },
    );
  }
}
