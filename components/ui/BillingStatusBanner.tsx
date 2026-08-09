"use client";

import { AlertTriangle, XCircle } from "lucide-react";

export type BillingStatus = "active" | "trial" | "past_due" | "suspended" | "canceled" | "enterprise" | "demo";

interface BillingStatusBannerProps {
  status: BillingStatus;
  gracePeriodEndsAt?: Date | string | null;
  shopName?: string;
}

export function BillingStatusBanner({ status, gracePeriodEndsAt, shopName }: BillingStatusBannerProps) {
  if (status === "active" || status === "trial" || status === "enterprise" || status === "demo") {
    return null;
  }

  const getDaysRemaining = () => {
    if (!gracePeriodEndsAt) return null;
    const endDate = typeof gracePeriodEndsAt === "string" ? new Date(gracePeriodEndsAt) : gracePeriodEndsAt;
    const now = new Date();
    const days = Math.ceil((endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return Math.max(0, days);
  };

  const daysRemaining = getDaysRemaining();

  if (status === "past_due") {
    return (
      <div className="bg-amber-50 border-l-4 border-amber-400 p-4 mb-4">
        <div className="flex items-start">
          <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 mr-3 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-amber-800">
              Payment Issue
            </h3>
            <p className="text-sm text-amber-700 mt-1">
              We couldn't process your payment. 
              {daysRemaining !== null && daysRemaining > 0 && (
                <> You have <strong>{daysRemaining} day{daysRemaining !== 1 ? "s" : ""}</strong> to update your payment method.</>
              )}
              {daysRemaining === 0 && (
                <> Your grace period ends today. Please update your payment immediately.</>
              )}
            </p>
            <p className="text-sm text-amber-700 mt-2">
              Please contact support at{" "}
              <a href="mailto:support@mosmaintenance.com" className="font-medium underline">
                support@mosmaintenance.com
              </a>{" "}
              to update your payment method.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "suspended") {
    return (
      <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-4">
        <div className="flex items-start">
          <XCircle className="h-5 w-5 text-red-500 mt-0.5 mr-3 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-red-800">
              Account Suspended
            </h3>
            <p className="text-sm text-red-700 mt-1">
              Your account has been temporarily suspended due to an unpaid balance. 
              Features are disabled, but your data is safe. Update your payment to restore full access.
            </p>
            <p className="text-sm text-red-700 mt-2">
              Please contact support at{" "}
              <a href="mailto:support@mosmaintenance.com" className="font-medium underline">
                support@mosmaintenance.com
              </a>{" "}
              to restore your account.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "canceled") {
    return (
      <div className="bg-gray-50 border-l-4 border-gray-400 p-4 mb-4">
        <div className="flex items-start">
          <AlertTriangle className="h-5 w-5 text-gray-500 mt-0.5 mr-3 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-gray-800">
              Subscription Canceled
            </h3>
            <p className="text-sm text-gray-700 mt-1">
              Your subscription has been canceled. Contact support at{" "}
              <a href="mailto:support@mosmaintenance.com" className="font-medium underline">
                support@mosmaintenance.com
              </a>{" "}
              to resubscribe and regain access to all features.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
