// app/dashboard/recommended/page.tsx
import { requireSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import RecommendedClient from "./RecommendedClient";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function RecommendedPage({
  searchParams,
}: {
  searchParams: { vin?: string; model?: string };
}) {
  const session = await requireSession();
  if (!session) {
    redirect("/login");
  }
  try {
    const entitlements = await getFeatureEntitlements(Number(session.shopId));
    if (!canAccessShopFeature(session, entitlements, "maintenance")) redirect("/dashboard");
  } catch {
    redirect("/dashboard");
  }

  const vin = searchParams.vin || "";
  const selectedModel = searchParams.model || "gpt-4o";

  return (
    <RecommendedClient 
      initialVin={vin} 
      initialModel={selectedModel} 
    />
  );
}