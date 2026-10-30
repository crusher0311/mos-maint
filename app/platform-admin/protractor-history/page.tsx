import { requirePlatformAdmin } from "@/lib/auth";
import ProtractorHistoryClient from "./ProtractorHistoryClient";

export const dynamic = "force-dynamic";

export default async function ProtractorHistoryPage() {
  await requirePlatformAdmin();
  return <ProtractorHistoryClient />;
}
