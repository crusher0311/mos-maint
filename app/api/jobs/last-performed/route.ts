import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { loadVehicleHistory, matchLastPerformed } from "@/lib/last-performed";

export const dynamic = "force-dynamic";

/**
 * Task #743 — "Last performed" lookup for the dashboard vehicle detail /
 * service view. Given the current vehicle VIN and one or more job/repair
 * names (repeated `name` params, or a single `q`), returns the most recent
 * time that service was performed on this vehicle (shop history or CARFAX),
 * or null when there is no record.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);

  const entitlements = await getFeatureEntitlements(shopId);
  if (!entitlements.canUseFeature("job_lookup")) {
    return NextResponse.json({ error: "Job Lookup is not available on your current plan" }, { status: 402 });
  }

  const { searchParams } = new URL(req.url);
  const vin = (searchParams.get("vin") || "").trim();
  const milesParam = searchParams.get("miles");
  const currentMiles = milesParam ? Number(milesParam) : null;
  const names = [
    ...searchParams.getAll("name"),
    ...(searchParams.get("q") ? [searchParams.get("q") as string] : []),
  ]
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 40);

  if (!vin || names.length === 0) {
    return NextResponse.json({ ok: true, results: [] });
  }

  try {
    const history = await loadVehicleHistory({
      shopId,
      vin,
      currentMiles: currentMiles && Number.isFinite(currentMiles) ? currentMiles : null,
    });

    const results = names.map((name) => ({
      name,
      lastPerformed: matchLastPerformed(history, name),
    }));

    return NextResponse.json({ ok: true, results });
  } catch (error: any) {
    console.error("[Jobs Last-Performed] Error:", error);
    return NextResponse.json({ ok: true, results: [] });
  }
}
