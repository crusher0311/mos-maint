"use client";

import { CreditCard, X, Loader2, Lock } from "lucide-react";
import { useState } from "react";

interface TrialInfo {
  endsAt: string | null;
  days: number | null;
  daysLeft: number | null;
}

interface Props {
  open: boolean;
  trial: TrialInfo;
  shopName?: string;
  required?: boolean;
  onClose: () => void;
  onAddCard: () => Promise<void> | void;
}

export function CardCaptureModal({ open, trial, shopName, required, onClose, onAddCard }: Props) {
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const daysLeft = trial.daysLeft ?? 0;
  const endsLabel = trial.endsAt
    ? new Date(trial.endsAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : null;

  const handleAdd = async () => {
    setSubmitting(true);
    try {
      await onAddCard();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden">
        <div className="bg-gradient-to-br from-[#3c81c3] to-[#2d6da8] p-6 text-white">
          <div className="flex items-start justify-between">
            <div className="bg-white/20 p-3 rounded-lg">
              <CreditCard className="w-6 h-6" />
            </div>
            {!required && (
              <button onClick={onClose} className="text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
          <h2 className="text-xl font-bold mt-4">
            Welcome{shopName ? ` to ${shopName}` : ""}!
          </h2>
          <p className="text-sm text-white/90 mt-1">
            {trial.days ? `Your ${trial.days}-day trial is active.` : "Your trial is active."}
          </p>
        </div>

        <div className="p-6 space-y-4">
          {endsLabel && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-900">
              Trial ends <b>{endsLabel}</b>
              {daysLeft > 0 && <span className="text-yellow-700"> ({daysLeft} days from now)</span>}
            </div>
          )}

          <div>
            <h3 className="font-semibold text-gray-900 text-sm mb-2">Why we ask now</h3>
            <ul className="text-sm text-gray-600 space-y-1.5">
              <li className="flex gap-2">
                <span className="text-[#3c81c3]">•</span>
                <span>No charge until your trial ends — your card is just on file.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-[#3c81c3]">•</span>
                <span>Service continues without interruption when the trial converts.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-[#3c81c3]">•</span>
                <span>Cancel anytime from Settings → Billing before trial ends.</span>
              </li>
            </ul>
          </div>

          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Lock className="w-3.5 h-3.5" />
            Secure payment by Stripe. Card details never touch our servers.
          </div>

          <div className="flex gap-2 pt-2">
            {!required && (
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium"
              >
                Later
              </button>
            )}
            <button
              onClick={handleAdd}
              disabled={submitting}
              className="flex-1 px-4 py-2.5 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] disabled:opacity-50 text-sm font-medium flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Add Payment Method
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
