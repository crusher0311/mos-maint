import { requirePlatformAdmin } from "@/lib/auth";
import ShopwareAuthorizationsClient from "./ShopwareAuthorizationsClient";

export const dynamic = "force-dynamic";

export default async function ShopwareAuthorizationsPage() {
  await requirePlatformAdmin();
  return <ShopwareAuthorizationsClient />;
}
