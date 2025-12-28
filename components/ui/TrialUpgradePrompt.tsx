"use client";

import Link from "next/link";
import { Lock, Zap, X } from "lucide-react";

interface TrialUpgradePromptProps {
  viewedCount: number;
  limit: number;
  onClose?: () => void;
}

export function TrialUpgradePrompt({ viewedCount, limit, onClose }: TrialUpgradePromptProps) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 relative">
        {onClose && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
          >
            <X className="w-5 h-5" />
          </button>
        )}
        
        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
            <Lock className="w-8 h-8 text-blue-600" />
          </div>
          
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Trial Limit Reached
          </h2>
          
          <p className="text-gray-600 mb-6">
            You've viewed <strong>{viewedCount}</strong> of <strong>{limit}</strong> free maintenance plans.
            Upgrade to Professional for unlimited access.
          </p>
          
          <div className="w-full space-y-3">
            <Link
              href="/dashboard/settings/billing"
              className="flex items-center justify-center gap-2 w-full py-3 px-4 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Zap className="w-5 h-5" />
              Upgrade to Professional
            </Link>
            
            <Link
              href="/dashboard"
              className="block w-full py-3 px-4 text-gray-600 font-medium rounded-lg hover:bg-gray-100 transition-colors"
            >
              Return to Dashboard
            </Link>
          </div>
          
          <div className="mt-6 pt-6 border-t border-gray-100 w-full">
            <p className="text-sm text-gray-500">
              Professional Plan: <strong>$199/month</strong> for unlimited vehicles
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TrialBanner({ viewedCount, limit }: { viewedCount: number; limit: number }) {
  const remaining = Math.max(0, limit - viewedCount);
  
  if (remaining > 3) return null;
  
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2">
      <div className="flex items-center justify-between max-w-7xl mx-auto">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-600" />
          <span className="text-sm text-amber-800">
            {remaining > 0 
              ? `${remaining} free plan views remaining`
              : "No free views remaining"
            }
          </span>
        </div>
        <Link
          href="/dashboard/settings/billing"
          className="text-sm font-medium text-amber-700 hover:text-amber-800 underline"
        >
          Upgrade now
        </Link>
      </div>
    </div>
  );
}
