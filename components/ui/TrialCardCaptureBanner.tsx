"use client";

import { CreditCard, AlertTriangle, Clock } from "lucide-react";

interface TrialInfo {
  active: boolean;
  endsAt: string | null;
  days: number | null;
  daysLeft: number | null;
  cardOnFile: boolean;
}

interface Props {
  trial: TrialInfo;
  onAddCard: () => void;
  loading?: boolean;
}

export function TrialCardCaptureBanner({ trial, onAddCard, loading }: Props) {
  if (!trial.endsAt || !trial.active) return null;
  if (trial.cardOnFile) return null;

  const daysLeft = trial.daysLeft ?? 0;
  const expired = daysLeft <= 0;
  const urgent = !expired && daysLeft <= 3;

  const tone = expired
    ? "bg-red-50 border-red-200 text-red-900"
    : urgent
    ? "bg-amber-50 border-amber-200 text-amber-900"
    : "bg-blue-50 border-blue-200 text-blue-900";

  const Icon = expired ? AlertTriangle : urgent ? AlertTriangle : Clock;

  const endsLabel = trial.endsAt
    ? new Date(trial.endsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "";

  const headline = expired
    ? "Your trial has ended"
    : daysLeft === 1
    ? "Your trial ends tomorrow"
    : `Your trial ends in ${daysLeft} days`;

  const sub = expired
    ? `Add a payment method to restore full access.`
    : `Add a payment method to keep service running after ${endsLabel}. You won't be charged until the trial ends.`;

  return (
    <div className={`mb-4 border rounded-lg px-4 py-3 flex items-center gap-3 ${tone}`}>
      <Icon className="w-5 h-5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{headline}</div>
        <div className="text-xs opacity-80">{sub}</div>
      </div>
      <button
        onClick={onAddCard}
        disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#3c81c3] text-white rounded text-sm font-medium hover:bg-[#2d6da8] disabled:opacity-50 flex-shrink-0"
      >
        <CreditCard className="w-4 h-4" />
        {loading ? "Loading…" : "Add Payment Method"}
      </button>
    </div>
  );
}
