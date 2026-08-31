import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

export default async function SalesCoachLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  try {
    const entitlements = await getFeatureEntitlements(Number(session.shopId));
    if (!canAccessShopFeature(session, entitlements, "sales_coach")) {
      redirect("/dashboard");
    }
  } catch {
    redirect("/dashboard");
  }
  return children;
}