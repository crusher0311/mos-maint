"use client";

import React, { useState, useEffect, Suspense } from "react";
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
  ChevronRight,
  Wrench,
  Search,
  AlertTriangle,
  Droplet,
  Tag,
  Chrome,
  Plus,
  ShoppingCart,
  X,
  Trash2
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

interface FeatureAddon {
  slug: string;
  name: string;
  description: string;
  icon: string;
  monthlyPrice: number;
  stripePriceId?: string;
  category: string;
  requiresFeature?: string;
}

interface CartItem {
  id: string;
  type: "vin-pack" | "feature";
  name: string;
  price: number;
  priceId: string;
  isRecurring: boolean;
  slug?: string;
  size?: number;
}

type TabType = "overview" | "plans" | "alacarte" | "payment" | "history";

export default function BillingSettingsPage() {
  return (
    <Suspense fallback={<div className="flex-1 p-8"><div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div></div>}>
      <BillingSettingsContent />
    </Suspense>
  );
}

function BillingSettingsContent() {
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [features, setFeatures] = useState<PlatformFeature[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [vinPacks, setVinPacks] = useState<VinPack[]>([]);
  const [featureAddons, setFeatureAddons] = useState<FeatureAddon[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("overview");
  const [cart, setCart] = useState<CartItem[]>([]);
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
        setFeatureAddons(data.featureAddons || []);
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
    if (!priceId) {
      setError("VIN pack not configured. Please contact support.");
      return;
    }
    setActionLoading(`vin-${packSize}`);
    setError(null);
    try {
      const res = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId, product: `vin-pack-${packSize}`, mode: "payment" }),
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

  function addVinPackToCart(pack: VinPack) {
    if (!pack.priceId) {
      setError("VIN pack not configured. Please contact support.");
      return;
    }
    const existingItem = cart.find(item => item.id === `vin-pack-${pack.size}`);
    if (existingItem) {
      setError("This VIN pack is already in your cart.");
      return;
    }
    const newItem: CartItem = {
      id: `vin-pack-${pack.size}`,
      type: "vin-pack",
      name: `${pack.size} VIN Pack`,
      price: pack.price,
      priceId: pack.priceId,
      isRecurring: false,
      size: pack.size,
    };
    setCart([...cart, newItem]);
    setSuccess(`Added ${pack.size} VIN Pack to cart`);
    setTimeout(() => setSuccess(null), 2000);
  }

  function addFeatureToCart(feature: FeatureAddon) {
    if (!feature.stripePriceId) {
      setError("Feature pricing not configured. Please contact support.");
      return;
    }
    const existingItem = cart.find(item => item.id === `feature-${feature.slug}`);
    if (existingItem) {
      setError("This feature is already in your cart.");
      return;
    }
    const newItem: CartItem = {
      id: `feature-${feature.slug}`,
      type: "feature",
      name: feature.name,
      price: feature.monthlyPrice,
      priceId: feature.stripePriceId,
      isRecurring: true,
      slug: feature.slug,
    };
    setCart([...cart, newItem]);
    setSuccess(`Added ${feature.name} to cart`);
    setTimeout(() => setSuccess(null), 2000);
  }

  function removeFromCart(itemId: string) {
    setCart(cart.filter(item => item.id !== itemId));
  }

  function clearCart() {
    setCart([]);
  }

  function isInCart(itemId: string) {
    return cart.some(item => item.id === itemId);
  }

  const cartTotal = cart.reduce((sum, item) => sum + item.price, 0);
  const recurringItems = cart.filter(item => item.isRecurring);
  const oneTimeItems = cart.filter(item => !item.isRecurring);
  const monthlyTotal = recurringItems.reduce((sum, item) => sum + item.price, 0);
  const oneTimeTotal = oneTimeItems.reduce((sum, item) => sum + item.price, 0);

  const hasMixedCart = recurringItems.length > 0 && oneTimeItems.length > 0;

  async function handleCartCheckout() {
    if (cart.length === 0) {
      setError("Your cart is empty");
      return;
    }
    if (hasMixedCart) {
      setError("You have both subscriptions and one-time purchases in your cart. Please checkout VIN packs and features separately.");
      return;
    }
    setActionLoading("checkout");
    setError(null);
    try {
      const lineItems = cart.map(item => ({
        priceId: item.priceId,
        type: item.type,
        slug: item.slug,
        size: item.size,
      }));
      
      const res = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          lineItems,
          isCart: true,
        }),
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
    { id: "alacarte" as const, label: "A La Carte", icon: Package },
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

        {activeTab === "alacarte" && (
          <div className="space-y-8">
            {cart.length > 0 && (
              <div className="bg-white rounded-xl border border-blue-200 shadow-sm overflow-hidden">
                <div className="bg-blue-50 px-4 py-3 border-b border-blue-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShoppingCart className="w-5 h-5 text-blue-600" />
                    <h3 className="font-semibold text-blue-900">Your Cart ({cart.length} {cart.length === 1 ? 'item' : 'items'})</h3>
                  </div>
                  <button
                    onClick={clearCart}
                    className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Clear
                  </button>
                </div>
                <div className="divide-y divide-gray-100">
                  {cart.map((item) => (
                    <div key={item.id} className="px-4 py-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${item.type === 'vin-pack' ? 'bg-blue-100' : 'bg-purple-100'}`}>
                          <Package className={`w-4 h-4 ${item.type === 'vin-pack' ? 'text-blue-600' : 'text-purple-600'}`} />
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{item.name}</p>
                          <p className="text-xs text-gray-500">
                            {item.isRecurring ? 'Monthly subscription' : 'One-time purchase'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="font-semibold text-gray-900">
                          ${item.price.toFixed(2)}{item.isRecurring ? '/mo' : ''}
                        </span>
                        <button
                          onClick={() => removeFromCart(item.id)}
                          className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="bg-gray-50 px-4 py-4 border-t border-gray-200">
                  <div className="space-y-2 mb-4">
                    {oneTimeTotal > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">One-time purchases:</span>
                        <span className="font-medium text-gray-900">${oneTimeTotal.toFixed(2)}</span>
                      </div>
                    )}
                    {monthlyTotal > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">Monthly subscriptions:</span>
                        <span className="font-medium text-gray-900">${monthlyTotal.toFixed(2)}/mo</span>
                      </div>
                    )}
                  </div>
                  {hasMixedCart && (
                    <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                      <p className="text-sm text-amber-800">
                        VIN packs and feature subscriptions must be checked out separately. 
                        Remove one type to proceed.
                      </p>
                    </div>
                  )}
                  <button
                    onClick={handleCartCheckout}
                    disabled={actionLoading === "checkout" || hasMixedCart}
                    className="w-full py-3 px-4 rounded-lg font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {actionLoading === "checkout" ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <CreditCard className="w-5 h-5" />
                    )}
                    Proceed to Checkout
                  </button>
                </div>
              </div>
            )}

            <div>
              <h2 className="text-lg font-semibold text-gray-900">VIN Packs</h2>
              <p className="text-gray-500 text-sm mt-1">
                Purchase additional vehicle lookups to add to your account
              </p>
            </div>

            {vinPacks.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                <Package className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="font-medium text-gray-900 mb-1">VIN packs not configured</h3>
                <p className="text-sm text-gray-500">
                  Contact support for more information.
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
                    {isInCart(`vin-pack-${pack.size}`) ? (
                      <button
                        onClick={() => removeFromCart(`vin-pack-${pack.size}`)}
                        className="w-full mt-6 py-2.5 px-4 rounded-lg font-medium bg-green-600 text-white hover:bg-red-600 transition-colors flex items-center justify-center gap-2 group"
                      >
                        <Check className="w-4 h-4 group-hover:hidden" />
                        <X className="w-4 h-4 hidden group-hover:block" />
                        <span className="group-hover:hidden">In Cart</span>
                        <span className="hidden group-hover:inline">Remove</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => addVinPackToCart(pack)}
                        disabled={!pack.priceId}
                        className="w-full mt-6 py-2.5 px-4 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        <ShoppingCart className="w-4 h-4" />
                        {pack.priceId ? "Add to Cart" : "Coming Soon"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-gray-200 pt-8">
              <h2 className="text-lg font-semibold text-gray-900">Individual Features</h2>
              <p className="text-gray-500 text-sm mt-1">
                Add individual features to your subscription
              </p>
            </div>

            {featureAddons.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                <Package className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="font-medium text-gray-900 mb-1">No features available</h3>
                <p className="text-sm text-gray-500">
                  Individual feature pricing is being configured.
                </p>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {featureAddons.map((feature) => {
                  const FeatureIcon = {
                    Wrench: Wrench,
                    Search: Search,
                    AlertTriangle: AlertTriangle,
                    Droplet: Droplet,
                    Tag: Tag,
                    RefreshCw: RefreshCw,
                    Calendar: Calendar,
                    Chrome: Chrome,
                  }[feature.icon] || Package;

                  const isIncluded = features.find(f => f.slug === feature.slug)?.includedInTiers?.includes(billing?.planSlug || "");

                  return (
                    <div
                      key={feature.slug}
                      className={`bg-white rounded-xl border p-5 transition-colors ${
                        isIncluded 
                          ? "border-green-200 bg-green-50/30" 
                          : "border-gray-200 hover:border-blue-300"
                      }`}
                    >
                      <div className="flex items-start gap-4">
                        <div className={`p-2.5 rounded-xl ${isIncluded ? "bg-green-100" : "bg-blue-100"}`}>
                          <FeatureIcon className={`w-5 h-5 ${isIncluded ? "text-green-600" : "text-blue-600"}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-gray-900">{feature.name}</h3>
                            {feature.category === "addon" && feature.requiresFeature && (
                              <span className="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">
                                Add-on
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                            {feature.description}
                          </p>
                          <div className="mt-3 flex items-center justify-between">
                            {feature.monthlyPrice > 0 ? (
                              <span className="font-bold text-gray-900">
                                ${feature.monthlyPrice.toFixed(2)}/mo
                              </span>
                            ) : (
                              <span className="text-sm text-gray-500">Contact for pricing</span>
                            )}
                            {isIncluded ? (
                              <span className="flex items-center gap-1 text-sm text-green-600 font-medium">
                                <Check className="w-4 h-4" />
                                Included
                              </span>
                            ) : isInCart(`feature-${feature.slug}`) ? (
                              <button
                                onClick={() => removeFromCart(`feature-${feature.slug}`)}
                                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-red-600 transition-colors flex items-center gap-1 group"
                              >
                                <Check className="w-3.5 h-3.5 group-hover:hidden" />
                                <X className="w-3.5 h-3.5 hidden group-hover:block" />
                                <span className="group-hover:hidden">In Cart</span>
                                <span className="hidden group-hover:inline">Remove</span>
                              </button>
                            ) : (
                              <button
                                onClick={() => addFeatureToCart(feature)}
                                disabled={!feature.stripePriceId}
                                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                              >
                                <ShoppingCart className="w-3.5 h-3.5" />
                                {feature.stripePriceId ? "Add to Cart" : "Coming Soon"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
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
