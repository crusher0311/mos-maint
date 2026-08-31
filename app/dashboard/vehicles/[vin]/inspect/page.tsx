// Task #991 — Auto DVI phone mode: server shell that gates the feature and
// renders the phone-optimized inspection client. Techs open this on a phone
// (logged into the dashboard) to run the whole inspection by voice + camera.

import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";
import MobileInspectClient from "./MobileInspectClient";

export const dynamic = "force-dynamic";

export default async function MobileInspectPage({
  params,
}: {
  params: Promise<{ vin: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { vin: rawVin } = await params;
  const vin = decodeURIComponent(rawVin || "").toUpperCase().trim();
  if (!vin) notFound();
  try {
    const ent = await getFeatureEntitlements(Number(session.shopId));
    if (
      !canAccessShopFeature(session, ent, "maintenance") ||
      !canAccessShopFeature(session, ent, "auto_dvi")
    ) redirect("/dashboard");
  } catch {
    redirect("/dashboard");
  }
  return <MobileInspectClient vin={vin} />;
}
