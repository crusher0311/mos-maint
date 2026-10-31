// app/dashboard/recommended/page.tsx
import { requireSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import RecommendedClient from "./RecommendedClient";
import { analyzerModel } from "@/lib/openai-model-policy";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function RecommendedPage({
  searchParams,
}: {
  searchParams: Promise<{ vin?: string; model?: string }>;
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

  const query = await searchParams;
  const vin = query.vin || "";
  const selectedModel = analyzerModel(query.model, "gpt-4o");
  if (!selectedModel) return <p role="alert">Unsupported AI model. Remove the model parameter and choose an approved model.</p>;

  return (
    <RecommendedClient 
      initialVin={vin} 
      initialModel={selectedModel} 
    />
  );
}