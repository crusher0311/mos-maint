"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import { 
  Activity, 
  AlertTriangle, 
  Clock, 
  Zap,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
  X,
  ChevronRight,
  ExternalLink,
  Filter,
  GripVertical
} from "lucide-react";

const PROVIDER_LOGOS: Record<string, string> = {
  tekmetric: "/logos/tekmetric.png",
  protractor: "/logos/protractor.png",
  openai: "/logos/openai.png",
  carfax: "/logos/carfax.png",
  dataone: "/logos/dataone.png",
  autoflow: "/logos/autoflow.png",
  hovercode: "/logos/hovercode.png",
};

const CARD_ORDER_STORAGE_KEY = "api-usage-card-order";

interface ProviderUsage {
  provider: string;
  name: string;
  currentMinute: number;
  last60Minutes: number;
  usagePercent?: number;
  warningLevel: 'ok' | 'warning' | 'critical' | 'stopped';
  avgLatencyMs: number;
  errorCount: number;
  rateLimitCount: number;
  topShops: Array<{ shopId: number; shopName?: string; count: number }>;
  hourlyUsage: Array<{ hour: string; requests: number; errors: number }>;
}

interface ApiUsageData {
  summary: {
    totalRequestsLastHour: number;
    totalErrorsLastHour: number;
    totalRateLimitsLastHour: number;
    overallStatus: 'ok' | 'warning' | 'critical';
  };
  providers: ProviderUsage[];
  lastUpdated: string;
}

interface ErrorRecord {
  _id: string;
  timestamp: string;
  provider: string;
  shopId?: number;
  shopName?: string;
  endpoint: string;
  method: string;
  statusCode: number;
  errorMessage?: string;
  errorCode?: string;
  latencyMs: number;
  requestId?: string;
  sourceWorker?: string;
}

interface DrawerState {
  type: 'errors' | 'shop' | null;
  provider?: string;
  shopId?: number;
  shopName?: string;
}

export default function ApiUsageDashboard() {
  const [data, setData] = useState<ApiUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [drawer, setDrawer] = useState<DrawerState>({ type: null });
  const [drawerData, setDrawerData] = useState<{
    errors?: ErrorRecord[];
    total?: number;
    hasMore?: boolean;
    stats?: { total: number; errors: number; avgLatency: number };
    breakdown?: { byStatusCode: any[]; byEndpoint: any[] };
  } | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<number | null>(null);
  const [cardOrder, setCardOrder] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const savedOrder = localStorage.getItem(CARD_ORDER_STORAGE_KEY);
      if (savedOrder) {
        return JSON.parse(savedOrder);
      }
    } catch (e) {
      console.error("Failed to parse saved card order");
    }
    return [];
  });
  const [draggedCard, setDraggedCard] = useState<string | null>(null);
  const dragOverCard = useRef<string | null>(null);

  const getOrderedProviders = useCallback(() => {
    if (!data?.providers) return [];
    if (cardOrder.length === 0) return data.providers;
    
    const providerMap = new Map(data.providers.map(p => [p.provider, p]));
    const ordered: ProviderUsage[] = [];
    
    for (const key of cardOrder) {
      const provider = providerMap.get(key);
      if (provider) {
        ordered.push(provider);
        providerMap.delete(key);
      }
    }
    
    for (const provider of providerMap.values()) {
      ordered.push(provider);
    }
    
    return ordered;
  }, [data?.providers, cardOrder]);

  const handleDragStart = (provider: string) => {
    setDraggedCard(provider);
  };

  const handleDragEnter = (provider: string) => {
    dragOverCard.current = provider;
  };

  const handleDragEnd = () => {
    if (draggedCard && dragOverCard.current && draggedCard !== dragOverCard.current) {
      const orderedProviders = getOrderedProviders();
      const currentOrder = orderedProviders.map(p => p.provider);
      
      const draggedIdx = currentOrder.indexOf(draggedCard);
      const overIdx = currentOrder.indexOf(dragOverCard.current);
      
      if (draggedIdx !== -1 && overIdx !== -1) {
        const newOrder = [...currentOrder];
        newOrder.splice(draggedIdx, 1);
        newOrder.splice(overIdx, 0, draggedCard);
        setCardOrder(newOrder);
        localStorage.setItem(CARD_ORDER_STORAGE_KEY, JSON.stringify(newOrder));
      }
    }
    setDraggedCard(null);
    dragOverCard.current = null;
  };

  const loadData = async () => {
    try {
      const res = await fetch("/api/platform-admin/api-usage");
      const json = await res.json();
      if (!json.error) {
        setData(json);
      }
    } catch (err) {
      console.error("Error loading API usage:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    
    if (autoRefresh) {
      const interval = setInterval(loadData, 30000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  const openErrorsDrawer = useCallback(async (provider?: string) => {
    setDrawer({ type: 'errors', provider });
    setDrawerLoading(true);
    setStatusFilter(null);
    
    try {
      const params = new URLSearchParams({ hours: '24' });
      if (provider) params.set('provider', provider);
      
      const [errorsRes, breakdownRes] = await Promise.all([
        fetch(`/api/platform-admin/api-usage/errors?${params}`),
        fetch(`/api/platform-admin/api-usage/errors?breakdown=true${provider ? `&provider=${provider}` : ''}`)
      ]);
      
      const [errorsData, breakdownData] = await Promise.all([
        errorsRes.json(),
        breakdownRes.json()
      ]);
      
      setDrawerData({
        errors: errorsData.errors || [],
        total: errorsData.total,
        hasMore: errorsData.hasMore,
        breakdown: breakdownData
      });
    } catch (err) {
      console.error("Error loading errors:", err);
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  const openShopDrawer = useCallback(async (shopId: number, provider?: string, shopName?: string) => {
    setDrawer({ type: 'shop', shopId, provider, shopName });
    setDrawerLoading(true);
    
    try {
      const params = new URLSearchParams({ hours: '24' });
      if (provider) params.set('provider', provider);
      
      const res = await fetch(`/api/platform-admin/api-usage/shops/${shopId}?${params}`);
      const data = await res.json();
      
      setDrawerData({
        errors: data.requests || [],
        total: data.total,
        hasMore: data.hasMore,
        stats: data.stats
      });
    } catch (err) {
      console.error("Error loading shop requests:", err);
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  const closeDrawer = () => {
    setDrawer({ type: null });
    setDrawerData(null);
  };

  const filterByStatus = async (statusCode: number | null) => {
    setStatusFilter(statusCode);
    setDrawerLoading(true);
    
    try {
      const params = new URLSearchParams({ hours: '24' });
      if (drawer.provider) params.set('provider', drawer.provider);
      if (statusCode) params.set('statusCode', statusCode.toString());
      
      const res = await fetch(`/api/platform-admin/api-usage/errors?${params}`);
      const data = await res.json();
      
      setDrawerData(prev => ({
        ...prev,
        errors: data.errors || [],
        total: data.total,
        hasMore: data.hasMore
      }));
    } catch (err) {
      console.error("Error filtering errors:", err);
    } finally {
      setDrawerLoading(false);
    }
  };

  const getStatusColor = (level: string) => {
    switch (level) {
      case 'critical':
      case 'stopped':
        return 'text-red-600 bg-red-100';
      case 'warning':
        return 'text-amber-600 bg-amber-100';
      default:
        return 'text-green-600 bg-green-100';
    }
  };

  const getStatusIcon = (level: string) => {
    switch (level) {
      case 'critical':
      case 'stopped':
        return <XCircle className="w-5 h-5" />;
      case 'warning':
        return <AlertCircle className="w-5 h-5" />;
      default:
        return <CheckCircle className="w-5 h-5" />;
    }
  };

  const getHttpStatusColor = (code: number) => {
    if (code >= 500) return 'bg-red-100 text-red-800';
    if (code >= 400) return 'bg-amber-100 text-amber-800';
    return 'bg-green-100 text-green-800';
  };

  const formatLatency = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-32 bg-gray-200 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6 relative">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Usage Dashboard</h1>
          <p className="text-gray-600">Real-time monitoring of external API calls</p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-gray-300"
            />
            Auto-refresh (30s)
          </label>
          <button
            onClick={loadData}
            className="flex items-center gap-2 px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Activity className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-gray-600">Requests (1hr)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {data?.summary.totalRequestsLastHour.toLocaleString() || 0}
          </div>
        </div>

        <button
          onClick={() => openErrorsDrawer()}
          className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 hover:border-red-200 hover:shadow-md transition-all text-left group"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-red-100 rounded-lg">
              <AlertTriangle className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-gray-600">Errors (1hr)</span>
            <ChevronRight className="w-4 h-4 text-gray-400 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {data?.summary.totalErrorsLastHour || 0}
          </div>
        </button>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-amber-100 rounded-lg">
              <Zap className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-sm text-gray-600">Rate Limits (1hr)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {data?.summary.totalRateLimitsLastHour || 0}
          </div>
        </div>

        <div className={`rounded-xl p-6 shadow-sm border ${
          data?.summary.overallStatus === 'critical' ? 'bg-red-50 border-red-200' :
          data?.summary.overallStatus === 'warning' ? 'bg-amber-50 border-amber-200' :
          'bg-green-50 border-green-200'
        }`}>
          <div className="flex items-center gap-3 mb-2">
            <div className={`p-2 rounded-lg ${getStatusColor(data?.summary.overallStatus || 'ok')}`}>
              {getStatusIcon(data?.summary.overallStatus || 'ok')}
            </div>
            <span className="text-sm text-gray-600">Overall Status</span>
          </div>
          <div className={`text-2xl font-bold capitalize ${
            data?.summary.overallStatus === 'critical' ? 'text-red-700' :
            data?.summary.overallStatus === 'warning' ? 'text-amber-700' :
            'text-green-700'
          }`}>
            {data?.summary.overallStatus || 'OK'}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Individual Integrations</h2>
          <span className="text-xs text-gray-400">Drag cards to reorder</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {getOrderedProviders().map((provider) => (
          <div 
            key={provider.provider} 
            className={`bg-white rounded-xl shadow-sm border overflow-hidden cursor-grab active:cursor-grabbing transition-all ${
              draggedCard === provider.provider ? 'opacity-50 scale-95 border-blue-300' : 'border-gray-100 hover:shadow-md'
            }`}
            draggable
            onDragStart={() => handleDragStart(provider.provider)}
            onDragEnter={() => handleDragEnter(provider.provider)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => e.preventDefault()}
          >
            <div className="p-4 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <GripVertical className="w-4 h-4 text-gray-300 flex-shrink-0" />
                {PROVIDER_LOGOS[provider.provider] ? (
                  <Image 
                    src={PROVIDER_LOGOS[provider.provider]} 
                    alt={provider.name} 
                    width={40} 
                    height={40} 
                    className="rounded-lg object-contain"
                  />
                ) : (
                  <div className={`p-2 rounded-lg ${getStatusColor(provider.warningLevel)}`}>
                    {getStatusIcon(provider.warningLevel)}
                  </div>
                )}
                <div>
                  <h3 className="font-semibold text-gray-900">{provider.name}</h3>
                  <p className="text-xs text-gray-500">{provider.provider}</p>
                </div>
              </div>
              <div className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(provider.warningLevel)}`}>
                {provider.warningLevel === 'ok' ? 'Healthy' : 
                 provider.warningLevel === 'stopped' ? 'Over Limit' :
                 provider.warningLevel === 'critical' ? 'Critical' : 'Warning'}
              </div>
            </div>

            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div title="API requests made in the current minute">
                  <div className="text-xs text-gray-500 mb-1">Current / min</div>
                  <div className="text-xl font-bold text-gray-900">{provider.currentMinute}</div>
                </div>
                <div title="Total API requests made in the last 60 minutes">
                  <div className="text-xs text-gray-500 mb-1">Last hour</div>
                  <div className="text-xl font-bold text-gray-900">{provider.last60Minutes}</div>
                </div>
              </div>

              {provider.usagePercent !== undefined && (
                <div title={`${provider.usagePercent}% of rate limit used. Green: <60%, Yellow: 60-85%, Red: >85%`}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-500">Usage</span>
                    <span className={`font-medium ${
                      provider.usagePercent > 85 ? 'text-red-600' :
                      provider.usagePercent > 60 ? 'text-amber-600' :
                      'text-green-600'
                    }`}>{provider.usagePercent}%</span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all ${
                        provider.usagePercent > 85 ? 'bg-red-500' :
                        provider.usagePercent > 60 ? 'bg-amber-500' :
                        'bg-green-500'
                      }`}
                      style={{ width: `${Math.min(provider.usagePercent, 100)}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-gray-50 rounded-lg p-2" title="Average response time for API calls in the last hour">
                  <div className="flex items-center justify-center gap-1 text-xs text-gray-500 mb-1">
                    <Clock className="w-3 h-3" />
                    Latency
                  </div>
                  <div className="text-sm font-medium text-gray-900">{formatLatency(provider.avgLatencyMs)}</div>
                </div>
                <button
                  onClick={() => provider.errorCount > 0 && openErrorsDrawer(provider.provider)}
                  disabled={provider.errorCount === 0}
                  className={`bg-gray-50 rounded-lg p-2 ${provider.errorCount > 0 ? 'hover:bg-red-50 cursor-pointer transition-colors' : ''}`}
                  title={provider.errorCount > 0 ? `${provider.errorCount} failed API calls in the last hour. Click to view details.` : 'No errors in the last hour'}
                >
                  <div className="flex items-center justify-center gap-1 text-xs text-gray-500 mb-1">
                    <AlertTriangle className="w-3 h-3" />
                    Errors
                  </div>
                  <div className={`text-sm font-medium ${provider.errorCount > 0 ? 'text-red-600 underline' : 'text-gray-900'}`}>
                    {provider.errorCount}
                  </div>
                </button>
                <div className="bg-gray-50 rounded-lg p-2" title="Rate limit responses (HTTP 429) in the last hour. These indicate the API is being called too frequently.">
                  <div className="flex items-center justify-center gap-1 text-xs text-gray-500 mb-1">
                    <Zap className="w-3 h-3" />
                    429s
                  </div>
                  <div className={`text-sm font-medium ${provider.rateLimitCount > 0 ? 'text-amber-600' : 'text-gray-900'}`}>
                    {provider.rateLimitCount}
                  </div>
                </div>
              </div>

              {provider.hourlyUsage && provider.hourlyUsage.length > 0 && (
                <div>
                  <div className="text-xs text-gray-500 mb-2">24h Usage Trend</div>
                  <div className="flex items-end gap-0.5 h-12">
                    {provider.hourlyUsage.slice(-24).map((hour: { hour: string; requests: number; errors: number }, i: number) => {
                      const maxCount = Math.max(...provider.hourlyUsage.map((h: { requests: number }) => h.requests), 1);
                      const height = (hour.requests / maxCount) * 100;
                      const hasErrors = hour.errors > 0;
                      const errorRate = hour.requests > 0 ? ((hour.errors / hour.requests) * 100).toFixed(1) : '0';
                      return (
                        <div
                          key={i}
                          className={`flex-1 rounded-t transition-all hover:opacity-80 ${
                            hasErrors ? 'bg-red-400' : 'bg-purple-400'
                          }`}
                          style={{ height: `${Math.max(height, 2)}%` }}
                          title={`${hour.hour}\n${hour.requests.toLocaleString()} requests\n${hasErrors ? `${hour.errors} errors (${errorRate}% error rate)` : 'No errors'}`}
                        />
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-end gap-3 mt-1">
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-sm bg-purple-400"></div>
                      <span className="text-[10px] text-gray-400">OK</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-sm bg-red-400"></div>
                      <span className="text-[10px] text-gray-400">Errors</span>
                    </div>
                  </div>
                </div>
              )}

              {provider.topShops && provider.topShops.length > 0 && (
                <div>
                  <div className="text-xs text-gray-500 mb-2">Top Shops by Usage</div>
                  <div className="space-y-1">
                    {provider.topShops.slice(0, 3).map((shop) => (
                      <button
                        key={shop.shopId}
                        onClick={() => openShopDrawer(shop.shopId, provider.provider, shop.shopName)}
                        className="flex items-center justify-between text-sm w-full hover:bg-gray-50 rounded px-1 py-0.5 transition-colors group"
                      >
                        <span className="text-blue-600 hover:underline truncate max-w-[140px]" title={shop.shopName || `Shop #${shop.shopId}`}>
                          {shop.shopName || `Shop #${shop.shopId}`}
                        </span>
                        <span className="font-medium text-gray-900 flex items-center gap-1">
                          {shop.count} req
                          <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        </div>
      </div>

      {data?.lastUpdated && (
        <div className="text-center text-sm text-gray-500">
          Last updated: {new Date(data.lastUpdated).toLocaleTimeString()}
        </div>
      )}

      {drawer.type && (
        <div className="fixed inset-0 bg-black/30 z-40" onClick={closeDrawer} />
      )}
      
      <div className={`fixed top-0 right-0 h-full w-full max-w-2xl bg-white shadow-2xl z-50 transform transition-transform duration-300 ${
        drawer.type ? 'translate-x-0' : 'translate-x-full'
      }`}>
        <div className="h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 flex items-center justify-between bg-gray-50">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {drawer.type === 'errors' ? 'Error Details' : `${drawer.shopName || `Shop #${drawer.shopId}`} Requests`}
              </h2>
              <p className="text-sm text-gray-500">
                {drawer.provider ? `Provider: ${drawer.provider}` : 'All providers'} - Last 24 hours
              </p>
            </div>
            <button
              onClick={closeDrawer}
              className="p-2 hover:bg-gray-200 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {drawer.type === 'shop' && drawerData?.stats && (
            <div className="p-4 bg-gray-50 border-b border-gray-200 grid grid-cols-3 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">{drawerData.stats.total}</div>
                <div className="text-xs text-gray-500">Total Requests</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-red-600">{drawerData.stats.errors}</div>
                <div className="text-xs text-gray-500">Errors</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">{formatLatency(drawerData.stats.avgLatency)}</div>
                <div className="text-xs text-gray-500">Avg Latency</div>
              </div>
            </div>
          )}

          {drawer.type === 'errors' && drawerData?.breakdown && (
            <div className="p-4 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <Filter className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium text-gray-700">Filter by Status</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => filterByStatus(null)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    statusFilter === null ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  All ({drawerData.total})
                </button>
                {drawerData.breakdown.byStatusCode.map((s) => (
                  <button
                    key={s.statusCode}
                    onClick={() => filterByStatus(s.statusCode)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      statusFilter === s.statusCode 
                        ? 'bg-purple-600 text-white' 
                        : `${getHttpStatusColor(s.statusCode)} hover:opacity-80`
                    }`}
                  >
                    {s.statusCode} ({s.count})
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4">
            {drawerLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map(i => (
                  <div key={i} className="animate-pulse bg-gray-100 rounded-lg h-20" />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {(drawerData?.errors || []).length === 0 ? (
                  <div className="text-center py-12 text-gray-500">
                    No records found
                  </div>
                ) : (
                  (drawerData?.errors || []).map((record) => (
                    <div key={record._id} className="bg-gray-50 rounded-lg p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${getHttpStatusColor(record.statusCode)}`}>
                            {record.statusCode}
                          </span>
                          <span className="text-xs font-mono text-gray-500">{record.method}</span>
                          <span className="text-xs text-gray-500">{formatLatency(record.latencyMs)}</span>
                        </div>
                        <span className="text-xs text-gray-400">{formatTime(record.timestamp)}</span>
                      </div>
                      
                      <div className="font-mono text-sm text-gray-800 break-all">
                        {record.endpoint}
                      </div>
                      
                      {record.errorMessage && (
                        <div className="text-sm text-red-600 bg-red-50 rounded p-2 break-words">
                          {record.errorMessage}
                        </div>
                      )}
                      
                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        <span>Provider: {record.provider}</span>
                        {record.shopId && (
                          <button
                            onClick={() => openShopDrawer(record.shopId!, record.provider, record.shopName)}
                            className="text-blue-600 hover:underline"
                          >
                            {record.shopName || `Shop #${record.shopId}`}
                          </button>
                        )}
                        {record.requestId && (
                          <span className="font-mono">{record.requestId}</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
                
                {drawerData?.hasMore && (
                  <div className="text-center py-4">
                    <span className="text-sm text-gray-500">
                      Showing {drawerData.errors?.length} of {drawerData.total} records
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
