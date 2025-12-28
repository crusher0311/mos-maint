"use client";

import { useEffect, useState } from "react";
import { TrialUpgradePrompt, TrialBanner } from "./TrialUpgradePrompt";

interface TrialStatus {
  isPaid: boolean;
  viewedCount: number;
  limit: number | null;
  remaining: number | null;
  requiresUpgrade: boolean;
  allowed: boolean;
}

interface PlanTrialGateProps {
  vin: string;
  children: React.ReactNode;
}

export function PlanTrialGate({ vin, children }: PlanTrialGateProps) {
  const [trialStatus, setTrialStatus] = useState<TrialStatus | null>(null);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);

  useEffect(() => {
    const checkAndTrackView = async () => {
      try {
        const res = await fetch("/api/trial/view-vin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vin }),
        });
        
        if (res.ok) {
          const data = await res.json();
          setTrialStatus(data);
          
          if (data.requiresUpgrade && !data.allowed) {
            setShowUpgradePrompt(true);
          }
        }
      } catch (err) {
        console.error("Error checking trial status:", err);
      }
    };

    checkAndTrackView();
  }, [vin]);

  if (showUpgradePrompt && trialStatus && !trialStatus.isPaid && trialStatus.limit !== null) {
    return (
      <TrialUpgradePrompt
        viewedCount={trialStatus.viewedCount}
        limit={trialStatus.limit}
      />
    );
  }

  return (
    <>
      {trialStatus && !trialStatus.isPaid && trialStatus.limit !== null && (
        <TrialBanner 
          viewedCount={trialStatus.viewedCount} 
          limit={trialStatus.limit} 
        />
      )}
      {children}
    </>
  );
}
