"use client";

import { useState, useEffect } from "react";
import { 
  CreditCard, 
  Check, 
  AlertCircle, 
  Loader2, 
  ExternalLink, 
  RefreshCw, 
  Receipt, 
  Wallet, 
  Calendar, 
  Building2,
  Package,
  ArrowUp,
  ArrowDown,
  Download,
  ChevronRight
} from "lucide-react";
import { useSearchParams } from "next/navigation";

interface BillingInfo {
  plan: string;
  planSlug: string;
  status: string;
  vehicleCount: number;
  vehicleLimit: number;
  nextBillingDate?: string;
  stripeCustomerId?: string;
  periodStart?: string;
  periodEnd?: string;
  monthlyAmount?: number;
  pendingPlanChange?: {
    planId: string;
    effectiveDate: string;
  };
}

interface Plan {
  name: string;
  slug: string;
  order: number;
  monthlyPrice: number;
  description: string;
  features: string[];
  stripeMonthlyPriceId?: string;
  isPopular?: boolean;
  isEnterprise?: boolean;
}

interface Invoice {
  id: string;
  number: string;
  amount: number;
  status: string;
  created: number;
  hostedInvoiceUrl?: string;
  invoicePdf?: string;
}

interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

interface PlatformFeature {
  _id: string;
  name: string;
  slug: string;
  description: string;
  includedInTiers: string[];
}

interface VinPack {
  size: number;
  price: number;
  priceId: string;
}

type TabType = "overview" | "plans" | "addons" | "payment" | "history";

export default function BillingSettingsPage() {
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [features, setFeatures] = useState<PlatformFeature[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [vinPacks, setVinPacks] = useState<VinPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("overview");
  const searchParams = useSearchParams();

  const checkoutSuccess = searchParams?.get("success");
  const checkoutCanceled = searchParams?.get("canceled");

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (checkoutSuccess) {
      setSuccess("Payment successful! Your plan has been updated.");
    } else if (checkoutCanceled) {
      setError("Checkout canceled. No changes were made.");
    }
  }, [checkoutSuccess, checkoutCanceled]);

  async function loadData() {
    setLoading(true);
    try {
      const [billingRes, plansRes, invoicesRes, paymentRes, addonsRes] = await Promise.all([
        fetch("/api/settings/billing"),
        fetch("/api/stripe/plans"),
        fetch("/api/stripe/invoices"),
        fetch("/api/stripe/payment-methods"),
        fetch("/api/settings/addons"),
      ]);

      if (billingRes.ok) {
        const data = await billingRes.json();
        setBilling(data);
      } else {
        setBilling({
          plan: "Free Trial",
          planSlug: "starter",
          status: "trial",
          vehicleCount: 0,
          vehicleLimit: 10,
        });
      }

      if (plansRes.ok) {
        const data = await plansRes.json();
        setPlans(data.plans || []);
        setFeatures(data.features || []);
      }

      if (invoicesRes.ok) {
        const data = await invoicesRes.json();
        setInvoices(data.invoices || []);
      }

      if (paymentRes.ok) {
        const data = await paymentRes.json();
        setPaymentMethods(data.paymentMethods || []);
      }

      if (addonsRes.ok) {
        const data = await addonsRes.json();
        setVinPacks(data.vinPacks || []);
      }
    } catch (err) {
      console.error("Error loading billing data:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handlePlanChange(plan: Plan, isDowngrade: boolean) {
    if (!plan.stripeMonthlyPriceId) {
      if (plan.isEnterprise) {
        window.location.href = "mailto:support@mosmaintenance.com?subject=Enterprise Plan Inquiry";
        return;
      }
      setError("This plan is not yet available for purchase.");
      return;
    }

    const action = isDowngrade ? "downgrade" : "upgrade";
    if (!confirm(`Are you sure you want to ${action} to ${plan.name}? ${isDowngrade ? "Changes will take effect at the end of your billing cycle." : "Your card will be charged a prorated amount."}`)) {
      return;
    }

    setActionLoading(plan.slug);
    setError(null);
    setSuccess(null);

    try {
      if (!billing?.stripeCustomerId) {
        const res = await fetch("/api/stripe/create-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priceId: plan.stripeMonthlyPriceId, plan: plan.slug }),
        });
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
        } else {
          throw new Error(data.error || "Failed to create checkout");
        }
        return;
      }

      const res = await fetch("/api/stripe/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priceId: plan.stripeMonthlyPriceId,
          planId: plan.slug,
          isDowngrade,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setSuccess(data.message);
        loadData();
      } else {
        throw new Error(data.error || "Failed to change plan");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleManageBilling() {
    setActionLoading("portal");
    setError(null);
    try {
      const res = await fetch("/api/stripe/billing-portal", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error(data.error || "Failed to open billing portal");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleBuyVinPack(packSize: number, priceId: string) {
    setActionLoading(`vin-${packSize}`);
    setError(null);
    try {
      const res = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId, product: `vin-pack-${packSize}` }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error(data.error || "Failed to create checkout");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  const isPaid = billing?.status === "active" && billing?.plan !== "Free Trial";
  const currentPlanIndex = plans.findIndex(p => p.slug === billing?.planSlug);

  const tabs = [
    { id: "overview" as const, label: "Overview", icon: Wallet },
    { id: "plans" as const, label: "Plans", icon: Package },
    { id: "addons" as const, label: "Add-Ons", icon: Package },
    { id: "payment" as const, label: "Payment Methods", icon: CreditCard },
    { id: "history" as const, label: "Billing History", icon: Receipt },
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
            Manage your subscription, payment methods, and billing history.
          </p>
        </div>

        {(success || checkoutSuccess) && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="flex items-center gap-2 text-green-800">
              <Check className="w-5 h-5" />
              <span className="font-medium">{success || "Payment successful!"}</span>
            </div>
          </div>
        )}

        {(error || checkoutCanceled) && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-center gap-2 text-red-800">
              <AlertCircle className="w-5 h-5" />
              <span className="font-medium">{error || "Checkout canceled."}</span>
            </div>
          </div>
        )}

        <div className="border-b border-gray-200">
          <nav className="flex gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 py-3 px-4 border-b-2 font-medium text-sm transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {activeTab === "overview" && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between flex-wrap gap-4">
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
                <div className="flex items-center gap-3">
                  <button
                    onClick={loadData}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Sync
                  </button>
                  {isPaid && (
                    <button
                      onClick={handleManageBilling}
                      disabled={actionLoading === "portal"}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      {actionLoading === "portal" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                      Manage Subscription
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <div className="p-2 bg-blue-100 rounded-lg">
                    <CreditCard className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Plan</p>
                    <p className="font-semibold text-gray-900">{billing?.plan || "Free Trial"}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <div className="p-2 bg-green-100 rounded-lg">
                    <Wallet className="w-5 h-5 text-green-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Monthly Amount</p>
                    <p className="font-semibold text-gray-900">
                      {billing?.monthlyAmount ? `$${(billing.monthlyAmount / 100).toFixed(2)}` : "Free"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <div className="p-2 bg-purple-100 rounded-lg">
                    <Building2 className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Vehicles</p>
                    <p className="font-semibold text-gray-900">{billing?.vehicleCount || 0} / {billing?.vehicleLimit || 10}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <div className="p-2 bg-amber-100 rounded-lg">
                    <Calendar className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Billing Period</p>
                    <p className="font-semibold text-gray-900">
                      {billing?.periodEnd
                        ? `Renews ${new Date(billing.periodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                        : "Monthly"}
                    </p>
                  </div>
                </div>
              </div>

              {billing?.pendingPlanChange && (
                <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-center gap-2 text-amber-800">
                    <AlertCircle className="w-5 h-5" />
                    <span>
                      Your plan will change to <strong>{billing.pendingPlanChange.planId}</strong> on {new Date(billing.pendingPlanChange.effectiveDate).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              )}

              {!isPaid && (
                <div className="mt-6">
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
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Choose Your Plan</h2>
              <p className="text-sm text-gray-500">
                Upgrade immediately (prorated) or downgrade at end of cycle
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
              {plans.map((plan, index) => {
                const isCurrent = plan.slug === billing?.planSlug;
                const isDowngrade = currentPlanIndex > index;
                const isUpgrade = currentPlanIndex < index;

                return (
                  <div
                    key={plan.slug}
                    className={`relative bg-white rounded-xl border-2 p-5 transition-all ${
                      isCurrent
                        ? "border-green-500 shadow-lg shadow-green-100"
                        : plan.isPopular
                          ? "border-blue-300"
                          : "border-gray-200"
                    }`}
                  >
                    {plan.isPopular && !isCurrent && (
                      <div className="absolute -top-3 left-4">
                        <span className="bg-blue-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                          Most Popular
                        </span>
                      </div>
                    )}
                    {isCurrent && (
                      <div className="absolute -top-3 left-4">
                        <span className="bg-green-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                          Current Plan
                        </span>
                      </div>
                    )}

                    <div className="mb-4 pt-2">
                      <h3 className="text-lg font-bold text-gray-900">{plan.name}</h3>
                      <div className="mt-2">
                        {plan.isEnterprise ? (
                          <span className="text-2xl font-bold text-gray-900">Custom</span>
                        ) : (
                          <>
                            <span className="text-2xl font-bold text-gray-900">
                              ${plan.monthlyPrice.toFixed(2)}
                            </span>
                            <span className="text-gray-500 text-sm">/month</span>
                          </>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">{plan.description}</p>
                    </div>

                    <div className="border-t border-gray-100 pt-4">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Included Features</p>
                      <ul className="space-y-2">
                        {features
                          .filter(f => f.includedInTiers.includes(plan.slug))
                          .slice(0, 6)
                          .map((feature) => (
                            <li key={feature.slug} className="flex items-center gap-2 text-sm">
                              <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 bg-green-100">
                                <Check className="w-2.5 h-2.5 text-green-600" />
                              </div>
                              <span className="text-gray-700">{feature.name}</span>
                            </li>
                          ))}
                        {features.filter(f => f.includedInTiers.includes(plan.slug)).length > 6 && (
                          <li className="text-xs text-gray-500">
                            +{features.filter(f => f.includedInTiers.includes(plan.slug)).length - 6} more
                          </li>
                        )}
                      </ul>
                    </div>

                    <div className="mt-5">
                      {isCurrent ? (
                        <button
                          disabled
                          className="w-full py-2.5 px-4 rounded-lg font-medium bg-gray-100 text-gray-400 cursor-not-allowed text-sm"
                        >
                          Current Plan
                        </button>
                      ) : plan.isEnterprise ? (
                        <a
                          href="mailto:support@mosmaintenance.com?subject=Enterprise Plan Inquiry"
                          className="block w-full py-2.5 px-4 rounded-lg font-medium bg-gray-900 text-white text-center hover:bg-gray-800 transition-colors text-sm"
                        >
                          Contact Sales
                        </a>
                      ) : (
                        <button
                          onClick={() => handlePlanChange(plan, isDowngrade)}
                          disabled={actionLoading === plan.slug}
                          className={`w-full py-2.5 px-4 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm ${
                            isDowngrade
                              ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                              : "bg-blue-600 text-white hover:bg-blue-700"
                          }`}
                        >
                          {actionLoading === plan.slug ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : isDowngrade ? (
                            <ArrowDown className="w-4 h-4" />
                          ) : (
                            <ArrowUp className="w-4 h-4" />
                          )}
                          {isDowngrade ? "Downgrade" : "Upgrade"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === "addons" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">VIN Packs</h2>
              <p className="text-gray-500 text-sm mt-1">
                Purchase additional vehicle lookups to add to your account
              </p>
            </div>

            {vinPacks.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                <Package className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="font-medium text-gray-900 mb-1">No add-ons available</h3>
                <p className="text-sm text-gray-500">
                  VIN pack add-ons are not yet configured. Contact support for more information.
                </p>
              </div>
            ) : (
              <div className="grid md:grid-cols-3 gap-4">
                {vinPacks.map((pack) => (
                  <div
                    key={pack.size}
                    className="bg-white rounded-xl border border-gray-200 p-6 hover:border-blue-300 transition-colors"
                  >
                    <div className="text-center">
                      <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-100 rounded-xl mb-4">
                        <Package className="w-6 h-6 text-blue-600" />
                      </div>
                      <h3 className="text-lg font-bold text-gray-900">{pack.size} VINs</h3>
                      <div className="mt-2">
                        <span className="text-3xl font-bold text-gray-900">${pack.price}</span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        ${(pack.price / pack.size).toFixed(2)} per VIN
                      </p>
                    </div>
                    <button
                      onClick={() => handleBuyVinPack(pack.size, pack.priceId)}
                      disabled={!pack.priceId || actionLoading === `vin-${pack.size}`}
                      className="w-full mt-6 py-2.5 px-4 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {actionLoading === `vin-${pack.size}` ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <CreditCard className="w-4 h-4" />
                      )}
                      {pack.priceId ? "Purchase" : "Coming Soon"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "payment" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Payment Methods</h2>
                <p className="text-gray-500 text-sm mt-1">
                  Manage your saved payment methods
                </p>
              </div>
              {isPaid && (
                <button
                  onClick={handleManageBilling}
                  disabled={actionLoading === "portal"}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                >
                  {actionLoading === "portal" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                  Manage in Stripe
                </button>
              )}
            </div>

            {paymentMethods.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                <CreditCard className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="font-medium text-gray-900 mb-1">No payment methods</h3>
                <p className="text-sm text-gray-500">
                  Payment methods will appear here after you subscribe to a plan
                </p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
                {paymentMethods.map((method) => (
                  <div key={method.id} className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="p-2 bg-gray-100 rounded-lg">
                        <CreditCard className="w-5 h-5 text-gray-600" />
                      </div>
                      <div>
                        <p className="font-medium text-gray-900 capitalize">
                          {method.brand} ending in {method.last4}
                        </p>
                        <p className="text-sm text-gray-500">
                          Expires {method.expMonth}/{method.expYear}
                        </p>
                      </div>
                    </div>
                    {method.isDefault && (
                      <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-700 rounded">
                        Default
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "history" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Billing History</h2>
              <p className="text-gray-500 text-sm mt-1">
                View and download your past invoices
              </p>
            </div>

            {invoices.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                <Receipt className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="font-medium text-gray-900 mb-1">No invoices yet</h3>
                <p className="text-sm text-gray-500">
                  Your billing history will appear here after your first payment
                </p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Invoice</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Date</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Amount</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Status</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {invoices.map((invoice) => (
                      <tr key={invoice.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          {invoice.number || invoice.id.slice(-8)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {new Date(invoice.created * 1000).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          ${(invoice.amount / 100).toFixed(2)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 text-xs font-medium rounded ${
                            invoice.status === "paid"
                              ? "bg-green-100 text-green-700"
                              : invoice.status === "open"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-gray-100 text-gray-700"
                          }`}>
                            {invoice.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {invoice.hostedInvoiceUrl && (
                              <a
                                href={invoice.hostedInvoiceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:text-blue-500 text-sm flex items-center gap-1"
                              >
                                View <ChevronRight className="w-3 h-3" />
                              </a>
                            )}
                            {invoice.invoicePdf && (
                              <a
                                href={invoice.invoicePdf}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1.5 hover:bg-gray-100 rounded-lg"
                              >
                                <Download className="w-4 h-4 text-gray-500" />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
