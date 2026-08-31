// Task #804: shop-level protection-plan roster.
//
// Per enabled chemical provider, lists:
//  - Enrolled vehicles (with at-risk flag when a provider-required service
//    is overdue in the latest cached provider plan variant)
//  - Eligible-but-not-enrolled vehicles (provider-branded jobs found in
//    the shop's service history) for advisor outreach.
//
// At-risk needs a recent plan build: vehicles without a fresh cached plan
// show "no recent plan" instead of a guess — visiting the vehicle's plan
// page refreshes it. Enrollment is metadata only and never changes plan
// math anywhere.
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getEnabledChemicalProviders } from "@/lib/plan-build/chemical-providers";
import {
  computeLapseRisk,
  detectProviderEligibility,
  getProviderBrandTokens,
} from "@/lib/plan-build/protection-plan";
import { findShopByShopId } from "@/lib/data/repositories/shops";
import { listEnrollmentsForShop } from "@/lib/data/repositories/protection-plan-enrollments";
import { findCachedPlanVariantsForVins } from "@/lib/data/repositories/cached-plans";
import { listBrandedJobRowsForShop } from "@/lib/data/repositories/job-index";
import { findVehicles } from "@/lib/data/repositories/vehicles";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RosterVehicle {
  vin: string;
  label: string;
}

// Vehicle docs are keyed by VIN only (no shopId field) — year/make/model
// labels are shop-agnostic, so a VIN-only lookup is correct here.
async function vehicleLabels(vins: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (vins.length === 0) return map;
  const docs = await findVehicles(
    { vin: { $in: vins } } as any,
    { projection: { vin: 1, year: 1, make: 1, model: 1 }, limit: vins.length },
  );
  for (const v of docs) {
    const label = [v.year, v.make, v.model].filter(Boolean).join(" ");
    if (v.vin) map.set(String(v.vin).toUpperCase(), label);
  }
  return map;
}

function VehicleRow({
  vin,
  label,
  detail,
  tone,
  badge,
}: {
  vin: string;
  label: string;
  detail?: string | null;
  tone?: "red" | "green" | "blue" | "gray";
  badge?: string | null;
}) {
  const badgeClasses =
    tone === "red"
      ? "bg-red-100 text-red-800"
      : tone === "green"
        ? "bg-green-100 text-green-800"
        : tone === "blue"
          ? "bg-blue-100 text-blue-800"
          : "bg-neutral-100 text-neutral-600";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 border-b border-neutral-100 last:border-b-0">
      <div className="min-w-0">
        <Link
          href={`/dashboard/vehicles/${vin}/plan`}
          className="text-sm font-medium text-blue-700 hover:underline"
        >
          {label || vin}
        </Link>
        <div className="text-xs text-neutral-500 font-mono">{vin}</div>
        {detail && <div className="text-xs text-neutral-600 mt-0.5">{detail}</div>}
      </div>
      {badge && (
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${badgeClasses}`}>
          {badge}
        </span>
      )}
    </li>
  );
}

export default async function ProtectionPlansPage() {
  const session = await requireSession();
  const shopId = Number(session.shopId);
  const entitlements = await getFeatureEntitlements(shopId);
  if (!canAccessShopFeature(session, entitlements, "maintenance")) redirect("/dashboard");

  const shop = await findShopByShopId(shopId, {
    "maintenance.chemicalProviders": 1,
    name: 1,
  });
  const providers = getEnabledChemicalProviders(
    (shop as any)?.maintenance?.chemicalProviders,
  );

  if (providers.length === 0) {
    return (
      <div className="p-6 max-w-4xl">
        <h1 className="text-2xl font-bold text-neutral-900">Protection Plans</h1>
        <p className="mt-3 text-sm text-neutral-600">
          No chemical providers are enabled for this shop yet. Add a provider
          schedule (e.g. BG) under{" "}
          <Link href="/dashboard/settings/intervals" className="text-blue-700 underline">
            Settings → Shop Intervals
          </Link>{" "}
          to start tracking protection-plan enrollment.
        </p>
      </div>
    );
  }

  const enrollments = await listEnrollmentsForShop(shopId);
  const enrolledVins = Array.from(new Set(enrollments.map((e) => e.vin)));
  const cachedByVin = await findCachedPlanVariantsForVins(shopId, enrolledVins);

  // Branded history scan once per provider (tokens differ per provider).
  const brandedByProvider = new Map<
    string,
    Array<{ vin: string; name: string; performedAt: Date | null }>
  >();
  for (const provider of providers) {
    const tokens = getProviderBrandTokens(provider);
    brandedByProvider.set(
      provider.id,
      await listBrandedJobRowsForShop(shopId, tokens),
    );
  }

  // Vehicle labels for everything we will render.
  const allVins = new Set<string>(enrolledVins);
  for (const rows of Array.from(brandedByProvider.values())) {
    for (const r of rows) allVins.add(r.vin);
  }
  const labels = await vehicleLabels(Array.from(allVins));

  return (
    <div className="p-6 max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Protection Plans</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Enrollment roster per provider: enrolled vehicles, lapse-risk
          warnings, and eligible vehicles for outreach. Enroll or un-enroll
          from each vehicle&apos;s plan page.
        </p>
      </div>

      {providers.map((provider) => {
        const providerEnrollments = enrollments.filter(
          (e) => e.providerId === provider.id,
        );
        const enrolledVinSet = new Set(providerEnrollments.map((e) => e.vin));

        // At-risk from the latest cached provider variant (if fresh).
        const enrolledRows = providerEnrollments.map((e) => {
          const cached = cachedByVin.get(e.vin);
          const variant = cached?.plans.find(
            (p) => p.id === `provider:${provider.id}`,
          );
          if (!variant) {
            return {
              vin: e.vin,
              enrolledAt: e.enrolledAt,
              atRisk: null as boolean | null,
              overdueTitles: [] as string[],
            };
          }
          const lapse = computeLapseRisk(provider, variant.buckets.overdue);
          return {
            vin: e.vin,
            enrolledAt: e.enrolledAt,
            atRisk: lapse.atRisk,
            overdueTitles: lapse.overdueRequired.map((s) => s.title),
          };
        });
        const atRiskRows = enrolledRows.filter((r) => r.atRisk === true);

        // Eligible = branded history, not enrolled in THIS provider.
        const branded = brandedByProvider.get(provider.id) ?? [];
        const namesByVin = new Map<string, string[]>();
        for (const row of branded) {
          if (enrolledVinSet.has(row.vin)) continue;
          const list = namesByVin.get(row.vin) ?? [];
          list.push(row.name);
          namesByVin.set(row.vin, list);
        }
        const eligibleRows: Array<RosterVehicle & { matches: string[] }> = [];
        for (const [vin, names] of Array.from(namesByVin.entries())) {
          const elig = detectProviderEligibility(provider, names);
          if (!elig.eligible) continue;
          eligibleRows.push({
            vin,
            label: labels.get(vin) || "",
            matches: elig.matches,
          });
        }
        eligibleRows.sort((a, b) => a.vin.localeCompare(b.vin));

        return (
          <section
            key={provider.id}
            className="bg-white border border-neutral-200 rounded-xl shadow-sm"
          >
            <div className="px-5 py-4 border-b border-neutral-200 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-neutral-900">
                {provider.name}
              </h2>
              <div className="flex gap-2 text-xs">
                <span className="px-2 py-1 rounded-full bg-green-100 text-green-800 font-semibold">
                  {enrolledRows.length} enrolled
                </span>
                <span className="px-2 py-1 rounded-full bg-red-100 text-red-800 font-semibold">
                  {atRiskRows.length} at risk
                </span>
                <span className="px-2 py-1 rounded-full bg-blue-100 text-blue-800 font-semibold">
                  {eligibleRows.length} eligible
                </span>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-0 md:divide-x divide-neutral-200">
              <div>
                <h3 className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Enrolled ({enrolledRows.length})
                </h3>
                {enrolledRows.length === 0 ? (
                  <p className="px-5 pb-4 text-sm text-neutral-500">
                    No vehicles enrolled yet.
                  </p>
                ) : (
                  <ul className="pb-2">
                    {enrolledRows.map((r) => (
                      <VehicleRow
                        key={r.vin}
                        vin={r.vin}
                        label={labels.get(r.vin) || ""}
                        detail={
                          r.atRisk === true
                            ? `Overdue: ${r.overdueTitles.join(", ")}`
                            : r.atRisk === null
                              ? "No recent plan build — open the plan page to refresh"
                              : `Enrolled ${r.enrolledAt?.toLocaleDateString?.() ?? ""} — on schedule`
                        }
                        tone={r.atRisk === true ? "red" : r.atRisk === null ? "gray" : "green"}
                        badge={
                          r.atRisk === true
                            ? "At risk"
                            : r.atRisk === null
                              ? "Unknown"
                              : "On track"
                        }
                      />
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Eligible, not enrolled ({eligibleRows.length})
                </h3>
                {eligibleRows.length === 0 ? (
                  <p className="px-5 pb-4 text-sm text-neutral-500">
                    No eligible vehicles found in service history.
                  </p>
                ) : (
                  <ul className="pb-2">
                    {eligibleRows.slice(0, 100).map((r) => (
                      <VehicleRow
                        key={r.vin}
                        vin={r.vin}
                        label={r.label}
                        detail={`History: ${r.matches.slice(0, 2).join(", ")}${r.matches.length > 2 ? ", …" : ""}`}
                        tone="blue"
                        badge="Eligible"
                      />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
