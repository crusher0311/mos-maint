"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { 
  ArrowLeft, 
  Building2, 
  CreditCard, 
  MapPin, 
  TrendingUp,
  Check,
  AlertCircle,
  Loader2,
  ExternalLink,
  Receipt,
  Settings,
  ChevronRight,
  X,
  Package,
  ArrowUp,
  ArrowDown,
  Download,
  History,
  Zap
} from "lucide-react";

interface LocationBilling {
  shopId: number;
  name: string;
  locationIdentifier: string | null;
  plan: string;
  planDisplay: string;
  status: string;
  vehicleCount: number;
  vinLimit: number | null;
  nextBillingDate: string | null;
  enabledFeatures: string[];
  stripeCustomerId?: string;
}

interface EnterpriseBilling {
  enterprise: {
    id: string;
    name: string;
    hasEnterpriseBilling: boolean;
    plan: string | null;
    status: string | null;
    stripeCustomerId: string | null;
    nextBillingDate: string | null;
  };
  summary: {
    totalLocations: number;
    activeLocations: number;
    totalVehicles: number;
  };
  locations: LocationBilling[];
}

interface Plan {
  name: string;
  slug: string;
  order: number;
  monthlyPrice: number;
  description: string;
  features: string[];
  stripeMonthlyPriceId?: string;
}

interface VinPack {
  size: number;
  price: number;
  priceId: string;
}

interface Invoice {
  id: string;
  number: string;
  amount: number;
  status: string;
  created: number;
  hostedInvoiceUrl?: string;
  invoicePdf?: string;
  shopName?: string;
}

type TabType = "overview" | "history";

export default function EnterpriseBillingPage() {
  const [data, setData] = useState<EnterpriseBilling | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("overview");
  
  const [selectedLocation, setSelectedLocation] = useState<LocationBilling | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [vinPacks, setVinPacks] = useState<VinPack[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadBillingData();
  }, []);

  const loadBillingData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [billingRes, plansRes, addonsRes, invoicesRes] = await Promise.all([
        fetch("/api/enterprise/billing"),
        fetch("/api/stripe/plans"),
        fetch("/api/settings/addons"),
        fetch("/api/enterprise/billing/invoices")
      ]);

      if (!billingRes.ok) {
        const json = await billingRes.json();
        setError(json.error || "Failed to load billing data");
        return;
      }
      
      const billingData = await billingRes.json();
      setData(billingData);

      if (plansRes.ok) {
        const plansData = await plansRes.json();
        setPlans(plansData.plans || []);
      }

      if (addonsRes.ok) {
        const addonsData = await addonsRes.json();
        setVinPacks(addonsData.vinPacks || []);
      }

      if (invoicesRes.ok) {
        const invoicesData = await invoicesRes.json();
        setInvoices(invoicesData.invoices || []);
      }
    } catch (err) {
      console.error("Error loading billing data:", err);
      setError("Failed to load billing data");
    } finally {
      setLoading(false);
    }
  };

  const handlePlanChange = async (location: LocationBilling, plan: Plan, isDowngrade: boolean) => {
    if (!plan.stripeMonthlyPriceId) {
      setError("This plan is not available for purchase.");
      return;
    }

    const action = isDowngrade ? "downgrade" : "upgrade";
    if (!confirm(`Are you sure you want to ${action} ${location.name} to ${plan.name}? ${isDowngrade ? "Changes will take effect at the end of the billing cycle." : "The card will be charged a prorated amount."}`)) {
      return;
    }

    setActionLoading(`plan-${plan.slug}`);
    setError(null);

    try {
      const res = await fetch("/api/enterprise/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: location.shopId,
          planSlug: plan.slug
        }),
      });

      const result = await res.json();
      
      if (!res.ok) {
        throw new Error(result.error || "Failed to change plan");
      }

      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }

      setSuccess(`${location.name} ${isDowngrade ? "will be downgraded" : "has been upgraded"} to ${plan.name}`);
      setSelectedLocation(null);
      loadBillingData();
    } catch (err: any) {
      setError(err.message || "Failed to change plan");
    } finally {
      setActionLoading(null);
    }
  };

  const handlePurchaseVinPack = async (location: LocationBilling, pack: VinPack) => {
    if (!confirm(`Purchase ${pack.size} additional VINs for ${location.name} for $${pack.price}?`)) {
      return;
    }

    setActionLoading(`vin-${pack.size}`);
    setError(null);

    try {
      const res = await fetch("/api/enterprise/billing/purchase-vins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: location.shopId,
          packSize: pack.size
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || "Failed to purchase VINs");
      }

      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }

      setSuccess(`${pack.size} VINs added to ${location.name}`);
      setSelectedLocation(null);
      loadBillingData();
    } catch (err: any) {
      setError(err.message || "Failed to purchase VINs");
    } finally {
      setActionLoading(null);
    }
  };

  const handleManagePayment = async (location: LocationBilling) => {
    setActionLoading(`payment-${location.shopId}`);
    try {
      const res = await fetch("/api/enterprise/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId: location.shopId }),
      });

      const result = await res.json();

      if (result.url) {
        window.location.href = result.url;
      } else {
        setError("Unable to open billing portal");
      }
    } catch (err) {
      setError("Failed to open billing portal");
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-100 text-green-700";
      case "trial":
        return "bg-blue-100 text-blue-700";
      case "past_due":
        return "bg-amber-100 text-amber-700";
      case "canceled":
        return "bg-red-100 text-red-700";
      default:
        return "bg-gray-100 text-gray-700";
    }
  };

  const getPlanColor = (plan: string) => {
    switch (plan) {
      case "enterprise":
        return "bg-purple-100 text-purple-700";
      case "elite":
        return "bg-indigo-100 text-indigo-700";
      case "plus":
        return "bg-blue-100 text-blue-700";
      case "starter":
        return "bg-teal-100 text-teal-700";
      case "professional":
        return "bg-green-100 text-green-700";
      default:
        return "bg-gray-100 text-gray-700";
    }
  };

  const getCurrentPlanOrder = (planSlug: string) => {
    const plan = plans.find(p => p.slug === planSlug);
    return plan?.order || 0;
  };

  if (loading) {
    return (
      <div className="flex-1 p-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex-1 p-8">
        <div className="max-w-4xl mx-auto">
          <Link 
            href="/dashboard/enterprise" 
            className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Enterprise
          </Link>
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
            <h3 className="font-medium text-red-900 mb-1">Unable to Load Billing</h3>
            <p className="text-sm text-red-700">{error || "An error occurred"}</p>
            <button 
              onClick={loadBillingData}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 bg-gray-50 min-h-screen">
      <div className="max-w-6xl mx-auto">
        <Link 
          href="/dashboard/enterprise" 
          className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Enterprise
        </Link>

        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center">
              <CreditCard className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Enterprise Billing</h1>
              <p className="text-gray-500">{data.enterprise.name} - Manage billing across all locations</p>
            </div>
          </div>
        </div>

        {success && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-xl flex items-center gap-3">
            <Check className="w-5 h-5 text-green-600" />
            <p className="text-green-700">{success}</p>
            <button onClick={() => setSuccess(null)} className="ml-auto text-green-600 hover:text-green-800">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-600" />
            <p className="text-red-700">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto text-red-600 hover:text-red-800">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === "overview"
                ? "bg-blue-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-100"
            }`}
          >
            <div className="flex items-center gap-2">
              <Building2 className="w-4 h-4" />
              Locations
            </div>
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === "history"
                ? "bg-blue-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-100"
            }`}
          >
            <div className="flex items-center gap-2">
              <History className="w-4 h-4" />
              Billing History
            </div>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                <MapPin className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Locations</p>
                <p className="text-2xl font-bold text-gray-900">{data.summary.totalLocations}</p>
              </div>
            </div>
            <p className="text-sm text-gray-500">
              {data.summary.activeLocations} with paid plans
            </p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Vehicles</p>
                <p className="text-2xl font-bold text-gray-900">{data.summary.totalVehicles.toLocaleString()}</p>
              </div>
            </div>
            <p className="text-sm text-gray-500">
              Across all locations
            </p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                <Building2 className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Enterprise Plan</p>
                <p className="text-2xl font-bold text-gray-900">
                  {data.enterprise.hasEnterpriseBilling ? (data.enterprise.plan || "Enterprise") : "Per-Location"}
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-500">
              {data.enterprise.hasEnterpriseBilling ? "Consolidated billing" : "Each location billed separately"}
            </p>
          </div>
        </div>

        {activeTab === "overview" && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Location Billing Details</h2>
              <span className="text-sm text-gray-500">{data.locations.length} locations</span>
            </div>

            <div className="divide-y divide-gray-100">
              {data.locations.map((location) => (
                <div 
                  key={location.shopId} 
                  className="px-6 py-4 hover:bg-gray-50 transition-colors cursor-pointer"
                  onClick={() => setSelectedLocation(location)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                        <MapPin className="w-5 h-5 text-gray-600" />
                      </div>
                      <div>
                        <h3 className="font-medium text-gray-900">{location.name}</h3>
                        {location.locationIdentifier && (
                          <p className="text-sm text-gray-500">{location.locationIdentifier}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-6">
                      <div className="text-right">
                        <p className="text-sm text-gray-500">Vehicles</p>
                        <p className="font-medium text-gray-900">
                          {location.vehicleCount.toLocaleString()}
                          {location.vinLimit && (
                            <span className="text-gray-400"> / {location.vinLimit.toLocaleString()}</span>
                          )}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${getPlanColor(location.plan)}`}>
                          {location.planDisplay}
                        </span>
                        <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${getStatusColor(location.status)}`}>
                          {location.status.charAt(0).toUpperCase() + location.status.slice(1)}
                        </span>
                      </div>

                      <ChevronRight className="w-5 h-5 text-gray-400" />
                    </div>
                  </div>

                  {location.nextBillingDate && (
                    <div className="mt-2 ml-14">
                      <p className="text-xs text-gray-500">
                        Next billing: {new Date(location.nextBillingDate).toLocaleDateString()}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="font-semibold text-gray-900">Billing History</h2>
            </div>

            {invoices.length === 0 ? (
              <div className="p-12 text-center">
                <Receipt className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500">No invoices yet</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {invoices.map((invoice) => (
                  <div key={invoice.id} className="px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                        <Receipt className="w-5 h-5 text-gray-600" />
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{invoice.number}</p>
                        <p className="text-sm text-gray-500">
                          {invoice.shopName && <span>{invoice.shopName} - </span>}
                          {new Date(invoice.created * 1000).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="font-medium text-gray-900">${(invoice.amount / 100).toFixed(2)}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          invoice.status === "paid" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"
                        }`}>
                          {invoice.status}
                        </span>
                      </div>
                      {invoice.invoicePdf && (
                        <a
                          href={invoice.invoicePdf}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-2 text-gray-400 hover:text-gray-600"
                        >
                          <Download className="w-5 h-5" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-8 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl border border-blue-200 p-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
              <Receipt className="w-6 h-6 text-blue-600" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-gray-900 mb-1">Need Consolidated Billing?</h3>
              <p className="text-sm text-gray-600 mb-4">
                Contact us to set up enterprise-wide billing with a single invoice for all your locations, 
                volume discounts, and dedicated account management.
              </p>
              <Link
                href="/dashboard/support"
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
              >
                <Settings className="w-4 h-4" />
                Contact Support
              </Link>
            </div>
          </div>
        </div>
      </div>

      {selectedLocation && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white">
              <div>
                <h2 className="text-xl font-bold text-gray-900">{selectedLocation.name}</h2>
                {selectedLocation.locationIdentifier && (
                  <p className="text-sm text-gray-500">{selectedLocation.locationIdentifier}</p>
                )}
              </div>
              <button
                onClick={() => setSelectedLocation(null)}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-sm text-gray-500 mb-1">Current Plan</p>
                  <p className="font-semibold text-gray-900">{selectedLocation.planDisplay}</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-sm text-gray-500 mb-1">Vehicles</p>
                  <p className="font-semibold text-gray-900">
                    {selectedLocation.vehicleCount.toLocaleString()}
                    {selectedLocation.vinLimit && (
                      <span className="font-normal text-gray-500"> / {selectedLocation.vinLimit.toLocaleString()}</span>
                    )}
                  </p>
                </div>
              </div>

              <div>
                <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-blue-600" />
                  Change Plan
                </h3>
                <div className="space-y-2">
                  {plans.filter(p => !p.slug.includes("enterprise")).map((plan) => {
                    const isCurrentPlan = plan.slug === selectedLocation.plan;
                    const currentOrder = getCurrentPlanOrder(selectedLocation.plan);
                    const isDowngrade = plan.order < currentOrder;
                    const isUpgrade = plan.order > currentOrder;

                    return (
                      <div
                        key={plan.slug}
                        className={`p-4 rounded-xl border ${
                          isCurrentPlan 
                            ? "border-blue-500 bg-blue-50" 
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-gray-900">{plan.name}</span>
                              {isCurrentPlan && (
                                <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded-full">Current</span>
                              )}
                            </div>
                            <p className="text-sm text-gray-500">${plan.monthlyPrice}/month</p>
                          </div>
                          {!isCurrentPlan && (
                            <button
                              onClick={() => handlePlanChange(selectedLocation, plan, isDowngrade)}
                              disabled={actionLoading === `plan-${plan.slug}`}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ${
                                isUpgrade
                                  ? "bg-blue-600 text-white hover:bg-blue-700"
                                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                              }`}
                            >
                              {actionLoading === `plan-${plan.slug}` ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : isUpgrade ? (
                                <>
                                  <ArrowUp className="w-3 h-3" />
                                  Upgrade
                                </>
                              ) : (
                                <>
                                  <ArrowDown className="w-3 h-3" />
                                  Downgrade
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {vinPacks.length > 0 && (
                <div>
                  <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    <Package className="w-4 h-4 text-green-600" />
                    Purchase Additional VINs
                  </h3>
                  <div className="grid grid-cols-3 gap-3">
                    {vinPacks.map((pack) => (
                      <button
                        key={pack.size}
                        onClick={() => handlePurchaseVinPack(selectedLocation, pack)}
                        disabled={actionLoading === `vin-${pack.size}`}
                        className="p-4 rounded-xl border border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-colors text-center"
                      >
                        {actionLoading === `vin-${pack.size}` ? (
                          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                        ) : (
                          <>
                            <p className="text-2xl font-bold text-gray-900">{pack.size}</p>
                            <p className="text-sm text-gray-500">VINs</p>
                            <p className="text-sm font-medium text-blue-600 mt-1">${pack.price}</p>
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selectedLocation.stripeCustomerId && (
                <div className="pt-4 border-t border-gray-200">
                  <button
                    onClick={() => handleManagePayment(selectedLocation)}
                    disabled={actionLoading === `payment-${selectedLocation.shopId}`}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors font-medium"
                  >
                    {actionLoading === `payment-${selectedLocation.shopId}` ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <CreditCard className="w-4 h-4" />
                        Manage Payment Method
                        <ExternalLink className="w-3 h-3 ml-1" />
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
