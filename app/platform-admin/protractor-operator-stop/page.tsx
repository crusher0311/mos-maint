import { requirePlatformAdmin } from "@/lib/auth";
import ProtractorLiveMonitor from "@/components/platform-admin/ProtractorLiveMonitor";
import ProtractorOperatorStopClient from "./ProtractorOperatorStopClient";

export const dynamic = "force-dynamic";

export default async function ProtractorOperatorStopPage() {
  await requirePlatformAdmin();
  return (
    <div className="space-y-6">
      <ProtractorOperatorStopClient />
      <ProtractorLiveMonitor />
    </div>
  );
}