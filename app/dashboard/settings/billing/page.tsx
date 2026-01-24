"use client";

import { useState, useEffect } from "react";
import { Suspense } from "react";
import { CreditCard, Check, AlertCircle, Loader2, Zap, ExternalLink } from "lucide-react";
import { useSearchParams } from "next/navigation";

interface BillingInfo {
  plan: string;
  status: string;
  vehicleCount: number;
  vehicleLimit: number;
  nextBillingDate?: string;
  stripeCustomerId?: string;
}

interface StripePrice {
  id: string;
  unitAmount: number;
  currency: string;
  interval: string;
  intervalCount: number;
  productName: string;
}

function BillingContent() {
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [prices, setPrices] = useState<StripePrice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  const success = searchParams.get("success");
  const canceled = searchParams.get("canceled");

  useEffect(() => {
    fetchBilling();
    fetchPrices();
  }, []);

  async function fetchBilling() {
    try {
      const res = await fetch("/api/settings/billing");
      if (res.ok) {
        const data = await res.json();
        setBilling(data);
      } else {
        setBilling({
          plan: "Free Trial",
          status: "trial",
          vehicleCount: 0,
          vehicleLimit: 10,
        });
      }
    } catch (err) {
      setBilling({
        plan: "Free Trial",
        status: "trial",
        vehicleCount: 0,
        vehicleLimit: 10,
      });
    } finally {
      setLoading(false);
    }
  }

  async function fetchPrices() {
    try {
      const res = await fetch("/api/stripe/prices");
      if (res.ok) {
        const data = await res.json();
        setPrices(data.prices || []);
      }
    } catch (err) {
      console.error("Failed to fetch prices:", err);
    }
  }

  async function handleUpgrade(priceId: string, plan: string) {
    setUpgrading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId, plan }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error || "Failed to create checkout session");
      }
    } catch (err) {
      setError("Failed to start checkout. Please try again.");
    } finally {
      setUpgrading(false);
    }
  }

  async function handleManageBilling() {
    setPortalLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/billing-portal", {
        method: "POST",
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error || "Failed to open billing portal");
      }
    } catch (err) {
      setError("Failed to open billing portal. Please try again.");
    } finally {
      setPortalLoading(false);
    }
  }

  const monthlyPrice = prices.find(p => p.interval === "month");

  const plans = [
    {
      name: "Free Trial",
      price: "Free",
      period: "",
      description: `Try with your first ${billing?.vehicleLimit || 10} vehicles`,
      features: [
        `${billing?.vehicleLimit || 10} vehicles included`,
        "OEM maintenance schedules",
        "CARFAX integration",
        "Protractor sync",
        "No credit card required",
      ],
      current: billing?.plan === "Free Trial",
      trial: true,
    },
    {
      name: "Professional",
      price: monthlyPrice ? `$${(monthlyPrice.unitAmount / 100).toFixed(0)}` : "$199",
      period: "/month",
      description: "For single-location shops",
      features: [
        "Unlimited vehicles",
        "Full Protractor integration",
        "CARFAX service history",
        "OEM + custom intervals",
        "Declined service tracking",
        "Up to 5 users",
        "Priority support",
      ],
      current: billing?.plan === "Professional" || billing?.plan === "professional",
      popular: true,
      priceId: monthlyPrice?.id,
      planKey: "professional",
    },
    {
      name: "Multi-Shop",
      price: "$149",
      period: "/location/month",
      description: "For 3+ locations",
      features: [
        "Everything in Professional",
        "Multi-location management",
        "Unlimited users",
        "Dedicated onboarding",
        "API access",
        "Volume discount",
      ],
      current: billing?.plan === "Multi-Shop" || billing?.plan === "enterprise",
      contactSales: true,
    },
  ];

  const isPaid = billing?.status === "active" && billing?.plan !== "Free Trial";

  if (loading) {
    return (
      <div className="flex-1 p-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <CreditCard className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
            <p className="text-sm text-gray-500">Manage your subscription and payment</p>
          </div>
        </div>

        {success && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-green-800">
              <Check className="w-5 h-5" />
              <span className="font-medium">Payment successful! Your plan has been upgraded.</span>
            </div>
          </div>
        )}

        {canceled && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-amber-800">
              <AlertCircle className="w-5 h-5" />
              <span className="font-medium">Checkout canceled. No charges were made.</span>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-red-800">
              <AlertCircle className="w-5 h-5" />
              <span className="font-medium">{error}</span>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">Current Plan</h2>
              <p className="text-2xl font-bold text-gray-900">{billing?.plan || "Free Trial"}</p>
              {!isPaid && (
                <>
                  <p className="text-sm text-gray-500 mt-1">
                    {billing?.vehicleCount || 0} of {billing?.vehicleLimit || 10} vehicles used
                  </p>
                  <div className="mt-2 w-full bg-gray-200 rounded-full h-2 max-w-xs">
                    <div 
                      className="bg-blue-600 h-2 rounded-full transition-all"
                      style={{ width: `${Math.min(100, ((billing?.vehicleCount || 0) / (billing?.vehicleLimit || 10)) * 100)}%` }}
                    />
                  </div>
                </>
              )}
              {isPaid && billing?.nextBillingDate && (
                <p className="text-sm text-gray-500 mt-1">
                  Next billing date: {new Date(billing.nextBillingDate).toLocaleDateString()}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                billing?.status === "active" 
                  ? "bg-green-100 text-green-800" 
                  : "bg-blue-100 text-blue-800"
              }`}>
                {billing?.status === "active" ? "Active" : "Free Trial"}
              </span>
              {isPaid && (
                <button
                  onClick={handleManageBilling}
                  disabled={portalLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
                >
                  {portalLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ExternalLink className="w-4 h-4" />
                  )}
                  Manage Billing
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-6 text-white">
          <div className="flex items-center gap-3 mb-2">
            <Zap className="w-5 h-5" />
            <h3 className="font-semibold">The Only Maintenance Tool for Protractor Shops</h3>
          </div>
          <p className="text-blue-100 text-sm">
            MOS is the first maintenance recommendation platform with full Protractor integration. 
            Sync vehicles, work orders, and add service packages directly to repair orders.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Available Plans</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`relative bg-white rounded-xl shadow-sm border-2 p-6 ${
                  plan.current 
                    ? "border-blue-600" 
                    : (plan as any).popular 
                      ? "border-blue-200" 
                      : "border-gray-200"
                }`}
              >
                {(plan as any).popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-blue-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                      Most Popular
                    </span>
                  </div>
                )}
                {plan.current && (
                  <div className="absolute -top-3 right-4">
                    <span className="bg-green-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                      Current
                    </span>
                  </div>
                )}
                <div className="mb-4">
                  <h3 className="text-xl font-bold text-gray-900">{plan.name}</h3>
                  <p className="text-sm text-gray-500 mt-1">{(plan as any).description}</p>
                  <div className="mt-3">
                    <span className="text-3xl font-bold text-gray-900">{plan.price}</span>
                    <span className="text-gray-500">{plan.period}</span>
                  </div>
                </div>
                <ul className="space-y-3 mb-6">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2 text-sm text-gray-600">
                      <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>
                {plan.current ? (
                  <button
                    disabled
                    className="w-full py-2 px-4 rounded-lg font-medium bg-gray-100 text-gray-400 cursor-not-allowed"
                  >
                    Current Plan
                  </button>
                ) : (plan as any).trial ? (
                  <button
                    disabled
                    className="w-full py-2 px-4 rounded-lg font-medium bg-gray-100 text-gray-500 cursor-not-allowed"
                  >
                    Active
                  </button>
                ) : (plan as any).contactSales ? (
                  <a
                    href="mailto:support@mosmaintenance.com?subject=Multi-Shop Plan Inquiry"
                    className="block w-full py-2 px-4 rounded-lg font-medium bg-gray-800 text-white text-center hover:bg-gray-900 transition-colors"
                  >
                    Contact Sales
                  </a>
                ) : (plan as any).priceId ? (
                  <button
                    onClick={() => handleUpgrade((plan as any).priceId, (plan as any).planKey)}
                    disabled={upgrading}
                    className="w-full py-2 px-4 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {upgrading && <Loader2 className="w-4 h-4 animate-spin" />}
                    Upgrade
                  </button>
                ) : (
                  <button
                    disabled
                    className="w-full py-2 px-4 rounded-lg font-medium bg-gray-100 text-gray-500 cursor-not-allowed"
                  >
                    Coming Soon
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-amber-50 rounded-xl p-6 border border-amber-100">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-amber-900">Ready to upgrade?</h3>
              <p className="text-sm text-amber-800 mt-1">
                Unlock unlimited vehicles and full functionality. 
                Questions? Email us at support@mosmaintenance.com
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BillingFallback() {
  return (
    <div className="p-8">
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    </div>
  );
}

export default function BillingSettingsPage() {
  return (
    <Suspense fallback={<BillingFallback />}>
      <BillingContent />
    </Suspense>
  );
}
