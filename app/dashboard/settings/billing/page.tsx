"use client";

import { useState, useEffect, Suspense } from "react";
import { CreditCard, Check, AlertCircle, Loader2, ExternalLink, RefreshCw, Receipt, Wallet, Calendar, Building2 } from "lucide-react";
import { useSearchParams } from "next/navigation";

interface BillingInfo {
  plan: string;
  status: string;
  vehicleCount: number;
  vehicleLimit: number;
  nextBillingDate?: string;
  stripeCustomerId?: string;
  periodStart?: string;
  periodEnd?: string;
}

interface StripePrice {
  id: string;
  unitAmount: number;
  currency: string;
  interval: string;
  intervalCount: number;
  productName: string;
}

type TabType = "overview" | "plans" | "features";

function BillingContent() {
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [prices, setPrices] = useState<StripePrice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("overview");
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

  async function handleSync() {
    setSyncLoading(true);
    await fetchBilling();
    setSyncLoading(false);
  }

  const monthlyPrice = prices.find(p => p.interval === "month");
  const isPaid = billing?.status === "active" && billing?.plan !== "Free Trial";

  const plans = [
    {
      name: "Starter",
      price: "Free",
      period: "",
      description: "Standalone Plan",
      features: [
        { name: "Auto Booking", included: false },
        { name: "CarFax Integration", included: false },
        { name: "Labor Rate Updater", included: false },
        { name: "Maintenance Guide", included: false },
        { name: "OEM Data Integration", included: false },
        { name: "Printing", included: true },
      ],
      current: billing?.plan === "Free Trial" || billing?.status === "trial",
      trial: true,
    },
    {
      name: "Plus",
      price: monthlyPrice ? `$${(monthlyPrice.unitAmount / 100).toFixed(2)}` : "$79.95",
      period: "/month",
      description: "Integrated Plan",
      features: [
        { name: "Labor Rate Updater", included: true },
        { name: "CarFax Integration", included: true },
        { name: "OEM Data Integration", included: true },
        { name: "Promised Time Tool", included: true },
        { name: "Auto Booking", included: true },
        { name: "Printing", included: true },
      ],
      current: false,
      popular: true,
      priceId: monthlyPrice?.id,
      planKey: "plus",
    },
    {
      name: "Professional",
      price: "$149.95",
      period: "/month",
      description: "Making Operations Simple",
      features: [
        { name: "Auto Booking", included: true },
        { name: "CarFax Integration", included: true },
        { name: "Chrome Extension", included: true },
        { name: "Labor Rate Updater", included: true },
        { name: "Maintenance Guide", included: true },
        { name: "OEM Data Integration", included: true },
      ],
      current: billing?.plan === "Professional" || billing?.plan === "professional",
      highlight: true,
      priceId: monthlyPrice?.id,
      planKey: "professional",
    },
    {
      name: "MOS",
      price: "$1,000.00",
      period: "/month",
      description: "",
      features: [
        { name: "Auto Booking", included: true },
        { name: "CarFax Integration", included: true },
        { name: "Chrome Extension", included: true },
        { name: "Labor Rate Updater", included: true },
        { name: "Maintenance Guide", included: true },
        { name: "OeM Data Integration", included: true },
      ],
      current: billing?.plan === "Multi-Shop" || billing?.plan === "enterprise",
      contactSales: true,
    },
  ];

  const features = [
    {
      name: "Printing",
      description: "Core set of printing features",
      enabled: true,
      compatible: true,
    },
    {
      name: "Chrome Extension",
      description: "Chrome browser extension",
      enabled: false,
      compatible: false,
      reason: "This feature is not compatible with your current shop management system.",
    },
    {
      name: "Labor Rate Updater",
      description: "Automated labor rate updates",
      enabled: false,
      compatible: false,
      reason: "This feature is not compatible with your current shop management system.",
    },
    {
      name: "CarFax Integration",
      description: "CarFax data integration",
      enabled: isPaid,
      compatible: isPaid,
      reason: isPaid ? undefined : "This feature is not compatible with your current shop management system.",
    },
    {
      name: "Maintenance Guide",
      description: "Maintenance Guide",
      enabled: isPaid,
      compatible: isPaid,
      reason: isPaid ? undefined : "This feature is not compatible with your current shop management system.",
    },
    {
      name: "OEM Data Integration",
      description: "OEM Data Integration",
      enabled: isPaid,
      compatible: isPaid,
      reason: isPaid ? undefined : "This feature is not compatible with your current shop management system.",
    },
  ];

  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "plans" as const, label: "Plans" },
    { id: "features" as const, label: "Features" },
  ];

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
    <div className="flex-1 p-8 overflow-auto bg-gray-50">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Billing & Subscription</h1>
          <p className="text-gray-500 mt-1">
            Manage your subscription, payment methods, and billing history. Choose a plan to subscribe and unlock features for your shop.
          </p>
        </div>

        {success && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="flex items-center gap-2 text-green-800">
              <Check className="w-5 h-5" />
              <span className="font-medium">Payment successful! Your plan has been upgraded.</span>
            </div>
          </div>
        )}

        {canceled && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <div className="flex items-center gap-2 text-amber-800">
              <AlertCircle className="w-5 h-5" />
              <span className="font-medium">Checkout canceled. No charges were made.</span>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-center gap-2 text-red-800">
              <AlertCircle className="w-5 h-5" />
              <span className="font-medium">{error}</span>
            </div>
          </div>
        )}

        <div className="border-b border-gray-200">
          <nav className="flex gap-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
                  activeTab === tab.id
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {activeTab === "overview" && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold text-gray-900">Current Subscription</h2>
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                      billing?.status === "active" 
                        ? "bg-green-100 text-green-700" 
                        : "bg-blue-100 text-blue-700"
                    }`}>
                      {billing?.status === "active" ? "Active" : "Trial"}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSync}
                    disabled={syncLoading}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${syncLoading ? 'animate-spin' : ''}`} />
                    Sync
                  </button>
                  {isPaid && (
                    <button
                      onClick={handleManageBilling}
                      disabled={portalLoading}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      {portalLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <ExternalLink className="w-4 h-4" />
                      )}
                      Manage Subscription
                    </button>
                  )}
                </div>
              </div>
              
              <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="p-2 bg-blue-100 rounded-lg">
                    <CreditCard className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Plan</p>
                    <p className="font-semibold text-gray-900">{billing?.plan || "Free Trial"}</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="p-2 bg-green-100 rounded-lg">
                    <Wallet className="w-5 h-5 text-green-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Status</p>
                    <p className="font-semibold text-gray-900 capitalize">{billing?.status || "trial"}</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="p-2 bg-purple-100 rounded-lg">
                    <Building2 className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Vehicles</p>
                    <p className="font-semibold text-gray-900">{billing?.vehicleCount || 0} / {billing?.vehicleLimit || 10}</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="p-2 bg-amber-100 rounded-lg">
                    <Calendar className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Period</p>
                    <p className="font-semibold text-gray-900">
                      {billing?.periodStart && billing?.periodEnd
                        ? `${new Date(billing.periodStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${new Date(billing.periodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                        : "Monthly"}
                    </p>
                  </div>
                </div>
              </div>

              {!isPaid && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-600">Vehicle Usage</span>
                    <span className="text-sm font-medium text-gray-900">
                      {billing?.vehicleCount || 0} of {billing?.vehicleLimit || 10} used
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full transition-all"
                      style={{ width: `${Math.min(100, ((billing?.vehicleCount || 0) / (billing?.vehicleLimit || 10)) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {!isPaid && (
              <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl p-6 text-white">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div>
                    <h3 className="text-lg font-semibold">Ready to upgrade?</h3>
                    <p className="text-blue-100 mt-1">
                      Unlock unlimited vehicles and full functionality with a paid plan.
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveTab("plans")}
                    className="px-6 py-2 bg-white text-blue-600 rounded-lg font-medium hover:bg-blue-50 transition-colors"
                  >
                    View Plans
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "plans" && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-gray-900">Choose Your Plan</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
              {plans.map((plan) => (
                <div
                  key={plan.name}
                  className={`relative bg-white rounded-xl border-2 p-5 transition-all ${
                    plan.highlight
                      ? "border-green-500 shadow-lg shadow-green-100"
                      : plan.current 
                        ? "border-blue-500" 
                        : plan.popular 
                          ? "border-blue-300" 
                          : "border-gray-200"
                  }`}
                >
                  {plan.popular && !plan.highlight && (
                    <div className="absolute -top-3 left-4">
                      <span className="bg-blue-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                        Most Popular
                      </span>
                    </div>
                  )}
                  {plan.highlight && (
                    <div className="absolute -top-3 left-4">
                      <span className="bg-green-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                        Current Plan
                      </span>
                    </div>
                  )}
                  
                  <div className="mb-4 pt-2">
                    <h3 className="text-lg font-bold text-gray-900">{plan.name}</h3>
                    <div className="mt-2">
                      <span className="text-2xl font-bold text-gray-900">{plan.price}</span>
                      <span className="text-gray-500 text-sm">{plan.period}</span>
                    </div>
                    {plan.description && (
                      <p className="text-xs text-gray-500 mt-1">{plan.description}</p>
                    )}
                  </div>
                  
                  <div className="border-t border-gray-100 pt-4">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Included Features</p>
                    <ul className="space-y-2">
                      {plan.features.map((feature) => (
                        <li key={feature.name} className="flex items-center gap-2 text-sm">
                          <div className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 ${
                            feature.included ? "bg-green-100" : "bg-gray-100"
                          }`}>
                            <Check className={`w-2.5 h-2.5 ${feature.included ? "text-green-600" : "text-gray-400"}`} />
                          </div>
                          <span className={feature.included ? "text-gray-700" : "text-gray-400"}>
                            {feature.name}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  
                  <div className="mt-5">
                    {plan.current ? (
                      <button
                        disabled
                        className="w-full py-2.5 px-4 rounded-lg font-medium bg-gray-100 text-gray-400 cursor-not-allowed text-sm"
                      >
                        Current Plan
                      </button>
                    ) : plan.trial ? (
                      <button
                        disabled
                        className="w-full py-2.5 px-4 rounded-lg font-medium bg-gray-100 text-gray-500 cursor-not-allowed text-sm"
                      >
                        Free Tier
                      </button>
                    ) : plan.contactSales ? (
                      <a
                        href="mailto:support@mosmaintenance.com?subject=Enterprise Plan Inquiry"
                        className="block w-full py-2.5 px-4 rounded-lg font-medium bg-gray-900 text-white text-center hover:bg-gray-800 transition-colors text-sm"
                      >
                        Contact Sales
                      </a>
                    ) : plan.priceId ? (
                      <button
                        onClick={() => handleUpgrade(plan.priceId!, plan.planKey!)}
                        disabled={upgrading}
                        className="w-full py-2.5 px-4 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
                      >
                        {upgrading && <Loader2 className="w-4 h-4 animate-spin" />}
                        Select Plan
                      </button>
                    ) : (
                      <button
                        disabled
                        className="w-full py-2.5 px-4 rounded-lg font-medium bg-gray-100 text-gray-500 cursor-not-allowed text-sm"
                      >
                        Coming Soon
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "features" && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-semibold text-gray-900">Printing</h3>
                  <p className="text-sm text-gray-500">Core set of printing features</p>
                </div>
                <div className="flex items-center gap-3">
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={true} disabled className="sr-only peer" />
                    <div className="w-11 h-6 bg-blue-600 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                  </label>
                  <button className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1">
                    <ExternalLink className="w-3.5 h-3.5" />
                    Settings
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="font-semibold text-gray-900 mb-2">Additional Features</h3>
              <p className="text-sm text-gray-500 mb-6">
                Features that require an upgrade or are not compatible with your system
              </p>
              
              <div className="space-y-4">
                {features.slice(1).map((feature) => (
                  <div key={feature.name} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium text-gray-900">{feature.name}</h4>
                        {!feature.compatible && (
                          <span className="text-xs text-red-600 flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" />
                            Not compatible
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500">{feature.description}</p>
                      {feature.reason && (
                        <p className="text-xs text-gray-400 mt-1">{feature.reason}</p>
                      )}
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={feature.enabled} 
                        disabled={!feature.compatible}
                        className="sr-only peer" 
                        readOnly
                      />
                      <div className={`w-11 h-6 rounded-full peer after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all ${
                        feature.enabled 
                          ? "bg-blue-600 peer-checked:after:translate-x-full" 
                          : "bg-gray-200"
                      } ${!feature.compatible ? "opacity-50 cursor-not-allowed" : ""}`}></div>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {!isPaid && (
              <div className="bg-amber-50 rounded-xl p-6 border border-amber-100">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="font-semibold text-amber-900">Upgrade to unlock more features</h3>
                    <p className="text-sm text-amber-800 mt-1">
                      Some features require a paid plan to be compatible with your shop management system.
                    </p>
                    <button
                      onClick={() => setActiveTab("plans")}
                      className="mt-3 text-sm font-medium text-amber-700 hover:text-amber-800"
                    >
                      View available plans →
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BillingFallback() {
  return (
    <div className="p-8 bg-gray-50">
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
