"use client";

// Task #804: advisor enroll / un-enroll control rendered inside the
// provider tab's protection-plan banner on the vehicle plan page.
// Enrollment is metadata only (default tab + badges + roster), so a
// router.refresh() after the API call is enough to repaint the badges.
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ProtectionPlanControls({
  vin,
  providerId,
  providerName,
  enrolled,
}: {
  vin: string;
  providerId: string;
  providerName: string;
  enrolled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/protection-plan/enrollment", {
        method: enrolled ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vin, providerId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.ok !== true) {
        setError(data?.error || `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 ${
          enrolled
            ? "border-neutral-300 text-neutral-600 hover:bg-neutral-100 bg-white"
            : "border-green-600 bg-green-600 text-white hover:bg-green-700"
        }`}
      >
        {busy
          ? "Saving…"
          : enrolled
            ? "Un-enroll"
            : `Enroll in ${providerName} plan`}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
