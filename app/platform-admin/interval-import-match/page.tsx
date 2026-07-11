import { requirePlatformAdmin } from "@/lib/auth";
import IntervalImportMatchClient from "./IntervalImportMatchClient";

export const dynamic = "force-dynamic";

export default async function IntervalImportMatchPage() {
  await requirePlatformAdmin();
  return <IntervalImportMatchClient />;
}
