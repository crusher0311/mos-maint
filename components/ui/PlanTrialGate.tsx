"use client";

import { useEffect } from "react";

interface PlanTrialGateProps {
  vin: string;
  children: React.ReactNode;
}

/**
 * Task #271: VIN-based gating removed. Plan pages always render.
 * We still ping `/api/trial/view-vin` so the (shopId, vin, roNumber) view is
 * recorded in `viewed_vins` for the admin "VINs viewed: N" running total.
 */
export function PlanTrialGate({ vin, children }: PlanTrialGateProps) {
  useEffect(() => {
    fetch("/api/trial/view-vin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vin }),
    }).catch((err) => console.error("Error tracking VIN view:", err));
  }, [vin]);

  return <>{children}</>;
}
