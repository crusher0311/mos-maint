import { requirePlatformAdmin } from "@/lib/auth";
import ProtractorOperatorStopClient from "./ProtractorOperatorStopClient";

export const dynamic = "force-dynamic";

export default async function ProtractorOperatorStopPage() {
  await requirePlatformAdmin();
  return <ProtractorOperatorStopClient />;
}