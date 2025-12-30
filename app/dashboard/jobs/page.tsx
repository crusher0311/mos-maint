// app/dashboard/jobs/page.tsx
// Job Lookup / Parts Intelligence Page

import { requireSession } from "@/lib/auth";
import JobLookupClient from "./JobLookupClient";

export const dynamic = "force-dynamic";

export default async function JobLookupPage() {
  const session = await requireSession();

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Job Lookup</h1>
        <p className="mt-1 text-sm text-gray-500">
          Search historical jobs to find parts, labor, and pricing. Add matching jobs to open work orders.
        </p>
      </div>

      <JobLookupClient />
    </div>
  );
}
