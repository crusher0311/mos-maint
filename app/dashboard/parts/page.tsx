// app/dashboard/parts/page.tsx
// Part Cross-Reference Page

import { requireSession } from "@/lib/auth";
import PartCrossRefClient from "./PartCrossRefClient";

export const dynamic = "force-dynamic";

export default async function PartCrossRefPage() {
  const session = await requireSession();

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Part Cross-Reference</h1>
        <p className="mt-1 text-sm text-gray-500">
          Find interchangeable parts across manufacturers based on vehicle compatibility and shop history.
        </p>
      </div>

      <PartCrossRefClient />
    </div>
  );
}
