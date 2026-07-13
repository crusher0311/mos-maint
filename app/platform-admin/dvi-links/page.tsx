import { requirePlatformAdmin } from "@/lib/auth";
import DviLinksClient from "./DviLinksClient";

export const dynamic = "force-dynamic";

export default async function DviLinksPage() {
  await requirePlatformAdmin();
  return <DviLinksClient />;
}
