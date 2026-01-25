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
  ExternalLink,
  AlertCircle,
  CheckCircle,
  Clock,
  XCircle,
  ChevronDown,
  ChevronRight
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
  vinLimit: number;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  createdAt?: string;
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
  starter: "bg-purple-100 text-purple-700",
  professional: "bg-purple-100 text-purple-700",
  enterprise: "bg-green-100 text-green-700",
  demo: "bg-yellow-100 text-yellow-700",
  churned: "bg-red-100 text-red-700",
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
        <RefreshCw className="w-8 h-8 animate-spin text-mos-purple" />
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
          <button
            onClick={loadBilling}
            className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
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
                <div className="p-2 bg-purple-100 rounded-lg">
                  <CreditCard className="w-5 h-5 text-mos-purple" />
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
                <div className="p-2 bg-purple-100 rounded-lg">
                  <TrendingUp className="w-5 h-5 text-purple-600" />
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
                      <span className={`px-2 py-1 rounded text-xs font-medium capitalize ${planColors[plan] || planColors.trial}`}>
                        {plan}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-32 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-mos-purple rounded-full"
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
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-mos-purple focus:border-transparent"
                />
              </div>
              <select
                value={planFilter}
                onChange={(e) => setPlanFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-mos-purple focus:border-transparent"
              >
                <option value="all">All Plans</option>
                <option value="trial">Trial</option>
                <option value="starter">Starter</option>
                <option value="professional">Professional</option>
                <option value="enterprise">Enterprise</option>
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
                            <span className="ml-2 px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded">
                              {shop.enterpriseName}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs font-medium capitalize ${planColors[shop.plan] || planColors.trial}`}>
                          {shop.plan}
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
                        <div className="text-center">
                          <div className={`text-sm font-medium ${shop.vinViewCount >= shop.vinLimit ? "text-red-600" : "text-gray-900"}`}>
                            {shop.vinViewCount} / {shop.vinLimit}
                          </div>
                          <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden mx-auto mt-1">
                            <div
                              className={`h-full rounded-full ${shop.vinViewCount >= shop.vinLimit ? "bg-red-500" : "bg-mos-purple"}`}
                              style={{ width: `${Math.min(100, (shop.vinViewCount / shop.vinLimit) * 100)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {shop.stripeCustomerId ? (
                          <a
                            href={`https://dashboard.stripe.com/customers/${shop.stripeCustomerId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-purple-600 hover:text-purple-700"
                          >
                            View <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <span className="text-sm text-gray-400">No customer</span>
                        )}
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
      </div>
    </div>
  );
}
