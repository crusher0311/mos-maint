"use client";

import { useEffect, useState } from "react";
import EstimateAssistPanel from "@/components/EstimateAssistPanel";

/**
 * Full-page Estimate Assist. All logic lives in EstimateAssistPanel (also
 * embedded by the dashboard's per-row Estimate Assist modal).
 *
 * Deep-link support (Task #833): other webapp pages can link here with
 * ?workOrderId=<normalized id or RO number> (alias ?wo=) to open the audit
 * tab with that RO preselected and the audit already running. Read via
 * window.location instead of useSearchParams() to avoid the Suspense
 * boundary requirement for client components.
 */
export default function EstimateAuditPage() {
  // null = still reading the URL (first client render); string ("" when no
  // param) once resolved, so the panel mounts exactly once with the prefill.
  const [wo, setWo] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setWo((params.get("workOrderId") || params.get("wo") || "").trim());
  }, []);

  if (wo === null) return null;
  return <EstimateAssistPanel initialWorkOrderId={wo || undefined} />;
}
