import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import DispatchPilot from "@/components/shop-dispatch/DispatchPilot";
import { getFeatureEntitlements } from "@/lib/featureResolver";

export default async function ShopWorkflowPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const entitlements = await getFeatureEntitlements(session.shopId);
  if (!entitlements.isFeatureEnabled("shop_workflow")) redirect("/dashboard");
  return <DispatchPilot />;
}
