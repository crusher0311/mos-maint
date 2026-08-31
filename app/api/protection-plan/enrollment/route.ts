// Task #804: advisor-facing enrollment API for chemical-provider
// protection plans (e.g. BG Lifetime Protection Plan).
//
// GET    ?vin=<vin>                    -> enrollments for that vehicle
// POST   { vin, providerId, notes? }   -> enroll (idempotent upsert)
// DELETE { vin, providerId }           -> un-enroll
//
// Enrollment is shop-side metadata only — it never changes plan math, so
// no plan-cache invalidation happens here. The provider must be an
// enabled chemical provider on the session's shop.
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnabledChemicalProviders } from "@/lib/plan-build/chemical-providers";
import { findShopByShopId } from "@/lib/data/repositories/shops";
import {
  enrollVehicle,
  listEnrollmentsForVehicle,
  unenrollVehicle,
} from "@/lib/data/repositories/protection-plan-enrollments";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIN_RE = /^[A-HJ-NPR-Z0-9]{11,17}$/i;

async function canUseMaintenance(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) return false;
  const entitlements = await getFeatureEntitlements(Number(session.shopId));
  return canAccessShopFeature(session, entitlements, "maintenance");
}

function badRequest(message: string) {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await canUseMaintenance(sess))) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
  }

  const vin = (req.nextUrl.searchParams.get("vin") || "").trim();
  if (!VIN_RE.test(vin)) return badRequest("Invalid VIN");

  const enrollments = await listEnrollmentsForVehicle(Number(sess.shopId), vin);
  return NextResponse.json({
    ok: true,
    enrollments: enrollments.map((e) => ({
      providerId: e.providerId,
      providerName: e.providerName ?? e.providerId,
      enrolledAt: e.enrolledAt?.toISOString?.() ?? null,
      enrolledBy: e.enrolledBy ?? null,
      notes: e.notes ?? null,
    })),
  });
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await canUseMaintenance(sess))) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const vin = typeof body?.vin === "string" ? body.vin.trim() : "";
  const providerId = typeof body?.providerId === "string" ? body.providerId.trim() : "";
  const notes =
    typeof body?.notes === "string" && body.notes.trim()
      ? body.notes.trim().slice(0, 500)
      : null;

  if (!VIN_RE.test(vin)) return badRequest("Invalid VIN");
  if (!providerId) return badRequest("Missing providerId");

  const shopId = Number(sess.shopId);
  const shop = await findShopByShopId(shopId, {
    "maintenance.chemicalProviders": 1,
  });
  const provider = getEnabledChemicalProviders(
    (shop as any)?.maintenance?.chemicalProviders,
  ).find((p) => p.id === providerId);
  if (!provider) {
    return badRequest("Unknown or disabled provider for this shop");
  }

  await enrollVehicle({
    shopId,
    vin,
    providerId: provider.id,
    providerName: provider.name,
    enrolledBy: sess.email || null,
    notes,
  });
  console.log(
    `[ProtectionPlan] Enrolled ${vin.toUpperCase()} in ${provider.id} for shop ${shopId} by ${sess.email}`,
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await canUseMaintenance(sess))) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const vin = typeof body?.vin === "string" ? body.vin.trim() : "";
  const providerId = typeof body?.providerId === "string" ? body.providerId.trim() : "";
  if (!VIN_RE.test(vin)) return badRequest("Invalid VIN");
  if (!providerId) return badRequest("Missing providerId");

  const removed = await unenrollVehicle(Number(sess.shopId), vin, providerId);
  console.log(
    `[ProtectionPlan] Un-enrolled ${vin.toUpperCase()} from ${providerId} for shop ${sess.shopId} by ${sess.email} (removed=${removed})`,
  );
  return NextResponse.json({ ok: true, removed });
}
