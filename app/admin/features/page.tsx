// app/admin/features/page.tsx
// Platform admin - Feature management page

import { requireSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import FeaturesClient from "./FeaturesClient";

export const dynamic = "force-dynamic";

export default async function AdminFeaturesPage() {
  const session = await requireSession();
  
  if (session.role !== "platform_admin" && session.role !== "admin") {
    redirect("/dashboard");
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Feature Management</h1>
        <p className="mt-1 text-sm text-gray-500">
          Enable or disable features for individual shops. Features can be tied to billing.
        </p>
      </div>

      <FeaturesClient />
    </div>
  );
}
