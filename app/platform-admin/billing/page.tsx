"use client";

import { useState, useEffect } from "react";
import { 
  CreditCard, 
  DollarSign, 
  Users, 
  TrendingUp, 
  Building2, 
  RefreshCw, 
  Search,
  Download,
  ExternalLink,
  AlertCircle,
  CheckCircle,
  Clock,
  XCircle,
  ChevronDown,
  ChevronRight,
  Link2,
  X
} from "lucide-react";

interface ShopBilling {
  shopId: number | string;
  name: string;
  locationIdentifier?: string | null;
  enterpriseName?: string | null;
  plan: string;
  status: string;
  isPaid: boolean;
  vinViewCount: number;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeSubscriptionAmount?: number | null;
  stripeProductName?: string | null;
  invoiceMonthlyAmount?: number | null;
  invoiceAudit?: InvoiceAuditEntry[];
  createdAt?: string;
}

interface InvoiceAuditEntry {
  performedBy: string | null;
  invoiceMonthlyAmount: number | null;
  status: string | null;
  createdAt: string;
}

interface BillingSummary {
  totalShops: number;
  paidShops: number;
  totalMRR: number;
  planCounts: Record<string, number>;
  statusCounts: Record<string, number>;
}

interface BillingEvent {
  id: string;
  type: string;
  shopId?: number;
  shopName?: string;
  amount?: number;
  currency?: string;
  status?: string;
  createdAt: string;
}

const planColors: Record<string, string> = {
  trial: "bg-gray-100 text-gray-700",
  starter: "bg-blue-100 text-blue-700",
  professional: "bg-[rgba(60,129,195,0.15)] text-[#3c81c3]",
  enterprise: "bg-green-100 text-green-700",
  detect_dog_founder: "bg-amber-100 text-amber-700",
  oil_sticker_legacy: "bg-purple-100 text-purple-700",
  appfueled_invoice: "bg-emerald-100 text-emerald-700",
  demo: "bg-yellow-100 text-yellow-700",
  churned: "bg-red-100 text-red-700",
};

const planLabels: Record<string, string> = {
  trial: "Trial",
  starter: "Starter",
  professional: "Professional",
  enterprise: "Enterprise",
  detect_dog_founder: "Detect Dog - Founder",
  oil_sticker_legacy: "Oil Sticker - Legacy",
  appfueled_invoice: "AppFueled Invoice",
  demo: "Demo",
  churned: "Churned",
};

const statusIcons: Record<string, React.ReactNode> = {
  trial: <Clock className="w-4 h-4 text-gray-500" />,
  active: <CheckCircle className="w-4 h-4 text-green-500" />,
  past_due: <AlertCircle className="w-4 h-4 text-yellow-500" />,
  canceled: <XCircle className="w-4 h-4 text-red-500" />,
  paused: <Clock className="w-4 h-4 text-orange-500" />,
};

export default function PlatformBillingPage() {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [shops, setShops] = useState<ShopBilling[]>([]);
  const [events, setEvents] = useState<BillingEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState<string>("all");
  const [showEvents, setShowEvents] = useState(false);

  const [linkShop, setLinkShop] = useState<ShopBilling | null>(null);
  const [linkCustomerId, setLinkCustomerId] = useState("");
  const [linkSubId, setLinkSubId] = useState("");
  const [linkPlan, setLinkPlan] = useState("");
  const [linkStatus, setLinkStatus] = useState("");
  const [linkInvoiceAmount, setLinkInvoiceAmount] = useState("");
  const [linkSaving, setLinkSaving] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [linkSuccess, setLinkSuccess] = useState("");

  useEffect(() => {
    loadBilling();
  }, []);

  const loadBilling = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/billing");
      const data = await res.json();
      if (data.ok) {
        setSummary(data.summary);
        setShops(data.shops || []);
        setEvents(data.recentEvents || []);
      }
    } catch (err) {
      console.error("Error loading billing:", err);
    } finally {
      setLoading(false);
    }
  };

  const openLinkModal = (shop: ShopBilling) => {
    setLinkShop(shop);
    setLinkCustomerId(shop.stripeCustomerId || "");
    setLinkSubId(shop.stripeSubscriptionId || "");
    setLinkPlan(shop.plan || "");
    setLinkStatus(shop.status || "");
    setLinkInvoiceAmount(
      shop.plan === "appfueled_invoice" && typeof shop.invoiceMonthlyAmount === "number"
        ? (shop.invoiceMonthlyAmount / 100).toFixed(2)
        : ""
    );
    setLinkError("");
  };

  const closeLinkModal = () => {
    setLinkShop(null);
    setLinkCustomerId("");
    setLinkSubId("");
    setLinkPlan("");
    setLinkStatus("");
    setLinkInvoiceAmount("");
    setLinkError("");
  };

  const saveLinkStripe = async () => {
    if (!linkShop) return;
    const isInvoicePlan = linkPlan === "appfueled_invoice";
    let monthlyAmountNumber: number | undefined;
    if (isInvoicePlan) {
      const parsed = parseFloat(linkInvoiceAmount);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setLinkError("Monthly amount (in dollars) is required for AppFueled Invoice");
        return;
      }
      monthlyAmountNumber = parsed;
    } else {
      if (!linkCustomerId.trim()) {
        setLinkError("Stripe Customer ID is required");
        return;
      }
      if (!linkCustomerId.startsWith("cus_")) {
        setLinkError("Customer ID must start with 'cus_'");
        return;
      }
    }
    if (linkSubId && !linkSubId.startsWith("sub_")) {
      setLinkError("Subscription ID must start with 'sub_'");
      return;
    }

    setLinkSaving(true);
    setLinkError("");
    try {
      const res = await fetch("/api/platform-admin/billing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: linkShop.shopId,
          stripeCustomerId: linkCustomerId.trim() || undefined,
          stripeSubscriptionId: linkSubId.trim() || undefined,
          plan: linkPlan || undefined,
          status: linkStatus || undefined,
          monthlyAmount: monthlyAmountNumber,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLinkError(data.error || "Failed to link Stripe");
        return;
      }
      if (data.stripeSubData && !data.stripeSubData.error) {
        const sub = data.stripeSubData;
        const parts = ["Linked successfully"];
        if (sub.productName) parts.push(`Product: ${sub.productName}`);
        if (sub.amount) parts.push(`Amount: $${(sub.amount / 100).toFixed(2)}/${sub.interval || "mo"}`);
        if (sub.status) parts.push(`Status: ${sub.status}`);
        setLinkSuccess(parts.join(" · "));
        setTimeout(() => setLinkSuccess(""), 5000);
      } else if (data.stripeSubData?.error) {
        setLinkSuccess(`Linked, but could not fetch subscription: ${data.stripeSubData.error}`);
        setTimeout(() => setLinkSuccess(""), 5000);
      }
      closeLinkModal();
      loadBilling();
    } catch (err) {
      setLinkError("Network error");
    } finally {
      setLinkSaving(false);
    }
  };

  const filteredShops = shops.filter(shop => {
    const matchesSearch = 
      shop.name.toLowerCase().includes(search.toLowerCase()) ||
      (shop.locationIdentifier?.toLowerCase().includes(search.toLowerCase())) ||
      String(shop.shopId).includes(search);
    const matchesPlan = planFilter === "all" || shop.plan === planFilter;
    return matchesSearch && matchesPlan;
  });

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const formatEventType = (type: string) => {
    return type.replace(/_/g, " ").replace(/\./g, " ").replace(/\b\w/g, l => l.toUpperCase());
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-[#3c81c3]" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Billing Overview</h1>
            <p className="text-gray-600">Monitor subscriptions, revenue, and payment status</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/api/platform-admin/billing/export"
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              title="Download monthly revenue CSV (includes Stripe and AppFueled Invoice shops)"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </a>
            <button
              onClick={loadBilling}
              className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
          </div>
        </div>

        {summary && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <DollarSign className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Monthly Revenue</p>
                  <p className="text-2xl font-bold text-gray-900">{formatCurrency(summary.totalMRR)}</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[rgba(60,129,195,0.15)] rounded-lg">
                  <CreditCard className="w-5 h-5 text-[#3c81c3]" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Paid Shops</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {summary.paidShops} <span className="text-sm font-normal text-gray-500">/ {summary.totalShops}</span>
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <TrendingUp className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Conversion Rate</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {summary.totalShops > 0 ? Math.round((summary.paidShops / summary.totalShops) * 100) : 0}%
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-yellow-100 rounded-lg">
                  <Building2 className="w-5 h-5 text-yellow-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">In Trial</p>
                  <p className="text-2xl font-bold text-gray-900">{summary.planCounts.trial || 0}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {summary && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm">
              <h3 className="font-semibold text-gray-900 mb-4">Plans Breakdown</h3>
              <div className="space-y-3">
                {Object.entries(summary.planCounts).map(([plan, count]) => (
                  <div key={plan} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${planColors[plan] || planColors.trial}`}>
                        {planLabels[plan] || plan}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-32 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[rgba(60,129,195,0.1)]0 rounded-full"
                          style={{ width: `${summary.totalShops > 0 ? (count / summary.totalShops) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium text-gray-700 w-8">{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm">
              <h3 className="font-semibold text-gray-900 mb-4">Status Overview</h3>
              <div className="space-y-3">
                {Object.entries(summary.statusCounts).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {statusIcons[status] || <Clock className="w-4 h-4 text-gray-400" />}
                      <span className="text-sm text-gray-700 capitalize">{status.replace(/_/g, " ")}</span>
                    </div>
                    <span className="text-sm font-medium text-gray-900">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {linkSuccess && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 px-4 py-3 rounded-xl">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            {linkSuccess}
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
          <div className="p-4 border-b border-gray-200">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search shops..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
                />
              </div>
              <select
                value={planFilter}
                onChange={(e) => setPlanFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
              >
                <option value="all">All Plans</option>
                <option value="trial">Trial</option>
                <option value="starter">Starter</option>
                <option value="professional">Professional</option>
                <option value="enterprise">Enterprise</option>
                <option value="detect_dog_founder">Detect Dog - Founder</option>
                <option value="oil_sticker_legacy">Oil Sticker - Legacy</option>
                <option value="appfueled_invoice">AppFueled Invoice</option>
                <option value="demo">Demo</option>
                <option value="churned">Churned</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Shop</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Plan</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Status</th>
                  <th className="text-center px-4 py-3 text-sm font-medium text-gray-600">VIN Usage</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Stripe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredShops.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                      {search || planFilter !== "all" ? "No shops match your filters" : "No shops found"}
                    </td>
                  </tr>
                ) : (
                  filteredShops.map((shop) => (
                    <tr key={shop.shopId} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{shop.name}</div>
                        <div className="text-xs text-gray-500">
                          {shop.locationIdentifier && <span className="mr-2">{shop.locationIdentifier}</span>}
                          ID: {shop.shopId}
                          {shop.enterpriseName && (
                            <span className="ml-2 px-1.5 py-0.5 bg-[rgba(60,129,195,0.15)] text-[#3c81c3] rounded">
                              {shop.enterpriseName}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${planColors[shop.plan] || planColors.trial}`}>
                          {planLabels[shop.plan] || shop.plan}
                        </span>
                        {shop.isPaid && (
                          <span className="ml-1 text-xs text-green-600">(Paid)</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {statusIcons[shop.status] || <Clock className="w-4 h-4 text-gray-400" />}
                          <span className="text-sm text-gray-700 capitalize">{shop.status.replace(/_/g, " ")}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-center text-sm text-gray-900">
                          VINs viewed: <span className="font-medium">{shop.vinViewCount.toLocaleString()}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            {shop.stripeCustomerId ? (
                              <a
                                href={`https://dashboard.stripe.com/customers/${shop.stripeCustomerId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
                              >
                                View <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : null}
                            <button
                              onClick={() => openLinkModal(shop)}
                              className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-[#3c81c3] transition-colors"
                              title={shop.stripeCustomerId ? "Edit Stripe link" : "Link Stripe customer"}
                            >
                              <Link2 className="w-3.5 h-3.5" />
                              {!shop.stripeCustomerId && "Link"}
                            </button>
                          </div>
                          {shop.plan === "appfueled_invoice" && typeof shop.invoiceMonthlyAmount === "number" ? (
                            <>
                              <span className="text-xs text-emerald-700">
                                ${(shop.invoiceMonthlyAmount / 100).toFixed(2)}/mo · Invoiced
                              </span>
                              {shop.invoiceAudit && shop.invoiceAudit.length > 0 && (
                                <span className="text-xs text-gray-500">
                                  Set by {shop.invoiceAudit[0].performedBy || "unknown"} on{" "}
                                  {new Date(shop.invoiceAudit[0].createdAt).toLocaleDateString()}
                                </span>
                              )}
                            </>
                          ) : shop.stripeSubscriptionAmount ? (
                            <span className="text-xs text-gray-500">
                              ${(shop.stripeSubscriptionAmount / 100).toFixed(2)}/mo
                              {shop.stripeProductName && ` · ${shop.stripeProductName}`}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {events.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
            <button
              onClick={() => setShowEvents(!showEvents)}
              className="w-full p-4 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
            >
              <h3 className="font-semibold text-gray-900">Recent Billing Events</h3>
              {showEvents ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
            </button>
            
            {showEvents && (
              <div className="border-t border-gray-200 divide-y divide-gray-100">
                {events.map((event) => (
                  <div key={event.id} className="px-4 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{formatEventType(event.type)}</p>
                      <p className="text-xs text-gray-500">
                        {event.shopName || `Shop ${event.shopId}`} - {new Date(event.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    {event.amount && (
                      <span className="text-sm font-medium text-green-600">
                        {formatCurrency(event.amount / 100)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {linkShop && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
              <div className="flex items-center justify-between p-5 border-b border-gray-200">
                <div>
                  <h3 className="font-semibold text-gray-900">Link Stripe Customer</h3>
                  <p className="text-sm text-gray-500 mt-0.5">{linkShop.name} (ID: {linkShop.shopId})</p>
                </div>
                <button onClick={closeLinkModal} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Stripe Customer ID {linkPlan !== "appfueled_invoice" && <span className="text-red-500">*</span>}
                  </label>
                  <input
                    type="text"
                    value={linkCustomerId}
                    onChange={(e) => setLinkCustomerId(e.target.value)}
                    placeholder={linkPlan === "appfueled_invoice" ? "cus_... (optional for AppFueled Invoice)" : "cus_..."}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Stripe Subscription ID
                  </label>
                  <input
                    type="text"
                    value={linkSubId}
                    onChange={(e) => setLinkSubId(e.target.value)}
                    placeholder="sub_... (optional)"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent text-sm"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Plan</label>
                    <select
                      value={linkPlan}
                      onChange={(e) => setLinkPlan(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent text-sm"
                    >
                      <option value="">No change</option>
                      <option value="trial">Trial</option>
                      <option value="starter">Starter</option>
                      <option value="professional">Professional</option>
                      <option value="enterprise">Enterprise</option>
                      <option value="oil_sticker_legacy">Oil Sticker - Legacy</option>
                      <option value="appfueled_invoice">AppFueled Invoice</option>
                      <option value="demo">Demo</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                    <select
                      value={linkStatus}
                      onChange={(e) => setLinkStatus(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent text-sm"
                    >
                      <option value="">No change</option>
                      <option value="active">Active</option>
                      <option value="trial">Trial</option>
                      <option value="past_due">Past Due</option>
                      <option value="canceled">Canceled</option>
                      <option value="paused">Paused</option>
                    </select>
                  </div>
                </div>

                {linkPlan === "appfueled_invoice" && linkShop?.invoiceAudit && linkShop.invoiceAudit.length > 0 && (
                  <div className="border border-gray-200 rounded-lg">
                    <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                      <h4 className="text-sm font-medium text-gray-700">AppFueled Invoice History</h4>
                    </div>
                    <div className="max-h-48 overflow-y-auto divide-y divide-gray-100">
                      {linkShop.invoiceAudit.map((entry, idx) => (
                        <div key={idx} className="px-3 py-2 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-gray-900">
                              {typeof entry.invoiceMonthlyAmount === "number"
                                ? `$${(entry.invoiceMonthlyAmount / 100).toFixed(2)}/mo`
                                : "—"}
                            </span>
                            <span className="text-gray-500">
                              {new Date(entry.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <div className="text-gray-600 mt-0.5">
                            By {entry.performedBy || "unknown"}
                            {entry.status && <span className="text-gray-400"> · {entry.status}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {linkPlan === "appfueled_invoice" && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Monthly Amount (USD) <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={linkInvoiceAmount}
                        onChange={(e) => setLinkInvoiceAmount(e.target.value)}
                        placeholder="0.00"
                        className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent text-sm"
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Amount this shop is invoiced each month, outside of Stripe.
                    </p>
                  </div>
                )}

                {linkError && (
                  <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    {linkError}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
                <button
                  onClick={closeLinkModal}
                  className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={saveLinkStripe}
                  disabled={linkSaving}
                  className="px-4 py-2 text-sm text-white bg-[#3c81c3] hover:bg-[#2d6ba3] rounded-lg transition-colors disabled:opacity-50"
                >
                  {linkSaving ? "Saving..." : linkPlan === "appfueled_invoice" ? "Save" : "Link Stripe"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
