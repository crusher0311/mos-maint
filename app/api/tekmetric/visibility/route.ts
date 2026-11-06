import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readTekmetricVisibilitySample } from "@/lib/data/repositories/tekmetric-visibility";
import { explainVisibility } from "@/lib/integrations/tekmetric/visibility";

/** Read-only, bounded snapshot diagnostic. Does not fetch provider or CARFAX. */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.shopId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const numbers = new URL(request.url).searchParams.get("ros")?.split(",") || [];
  if (numbers.length > 10 || numbers.some(n => !/^\d{1,12}$/.test(n))) {
    return NextResponse.json({ error: "Supply at most ten RO numbers" }, { status: 400 });
  }
  const { shop, rows } = await readTekmetricVisibilitySample(session.shopId, numbers);
  const counts: Record<string, number> = {};
  for (const row of rows.slice(0, 2000)) {
    const reason = explainVisibility(row, shop?.preferences);
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return NextResponse.json({
    shopId: session.shopId, providerShopId: shop?.tekmetric?.shopId,
    measure: "Cached RO eligibility sample, not historical vehicles, unique vehicles, or an exact dashboard count",
    coverage: rows.length > 2000 ? "capped" : "complete_for_query", counts,
    samples: numbers.map(n => ({ ro: n, reason: explainVisibility(rows.find(r => String(r.workOrderNumber) === n), shop?.preferences) })),
    caveat: "Dashboard search, mileage fallback and other-provider merging can change membership. Not received means no retained snapshot, not proof that no webhook was delivered.",
    preferences: shop?.preferences ? { showOnlyWithMileage: shop.preferences.showOnlyWithMileage ?? true, tekmetricLabels: shop.preferences.tekmetricLabels || [] } : { showOnlyWithMileage: true, tekmetricLabels: [] },
    lastSyncOutcome: shop?.tekmetric?.lastActiveSyncOutcome ?? null,
  });
}
