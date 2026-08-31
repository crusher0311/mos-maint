// app/dashboard/analyzer/[vin]/page.tsx
import { analyzeMaintenance } from "@/lib/analyzer";
import { buildEvidenceForVIN } from "@/lib/evidence";
import AnalyzerResults from "@/components/AnalyzerResults";
import EvidencePanel from "@/components/EvidencePanel";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = { params: { vin: string } };

export default async function AnalyzerPage({ params }: Props) {
  const session = await requireSession();
  try {
    const entitlements = await getFeatureEntitlements(Number(session.shopId));
    if (!canAccessShopFeature(session, entitlements, "maintenance")) redirect("/dashboard");
  } catch {
    redirect("/dashboard");
  }
  const vin = params.vin.toUpperCase();

  // 1) Gather grounding (DVI + CARFAX + OE) from Mongo
  const evidence = await buildEvidenceForVIN(vin);

  // 2) Run the analyzer once on the server
  const analysis = await analyzeMaintenance({
    vin: evidence.vehicle.vin,
    miles: evidence.current_odometer_miles ?? evidence.last_known_mileage ?? null,
  });

  return (
    <main className="mx-auto max-w-7xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Analyzer: {vin}</h1>

      {/* Analysis results */}
      <AnalyzerResults result={analysis} />

      {/* Raw evidence (DVI, CARFAX, OE) */}
      <EvidencePanel evidence={evidence} />
    </main>
  );
}
