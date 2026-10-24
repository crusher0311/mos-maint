import { requireSession } from "@/lib/auth";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vehicle pages and bookmarks retain this URL. Use one configuration flow so
// saved-versus-enabled messaging, session checks and error handling cannot drift.
export default async function CarfaxSettingsPage() {
  await requireSession();
  redirect("/dashboard/settings/integrations#carfax");
}
