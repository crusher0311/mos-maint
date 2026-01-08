"use client";

import { useState, useEffect } from "react";
import { 
  Activity, 
  AlertTriangle, 
  TrendingUp, 
  Clock, 
  Zap,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle
} from "lucide-react";

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
  topShops: Array<{ shopId: number; count: number }>;
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

export default function ApiUsageDashboard() {
  const [data, setData] = useState<ApiUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

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

  const formatLatency = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
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
    <div className="p-8 space-y-6">
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

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-red-100 rounded-lg">
              <AlertTriangle className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-gray-600">Errors (1hr)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {data?.summary.totalErrorsLastHour || 0}
          </div>
        </div>

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
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Individual Integrations</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {(data?.providers || []).map((provider) => (
          <div key={provider.provider} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-4 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${getStatusColor(provider.warningLevel)}`}>
                  {getStatusIcon(provider.warningLevel)}
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">{provider.name}</h3>
                  <p className="text-xs text-gray-500">{provider.provider}</p>
                </div>
              </div>
              <div className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(provider.warningLevel)}`}>
                {provider.warningLevel === 'ok' ? 'Healthy' : provider.warningLevel.toUpperCase()}
              </div>
            </div>

            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-gray-500 mb-1">Current / min</div>
                  <div className="text-xl font-bold text-gray-900">{provider.currentMinute}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">Last hour</div>
                  <div className="text-xl font-bold text-gray-900">{provider.last60Minutes}</div>
                </div>
              </div>

              {provider.usagePercent !== undefined && (
                <div>
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
                <div className="bg-gray-50 rounded-lg p-2">
                  <div className="flex items-center justify-center gap-1 text-xs text-gray-500 mb-1">
                    <Clock className="w-3 h-3" />
                    Latency
                  </div>
                  <div className="text-sm font-medium text-gray-900">{formatLatency(provider.avgLatencyMs)}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <div className="flex items-center justify-center gap-1 text-xs text-gray-500 mb-1">
                    <AlertTriangle className="w-3 h-3" />
                    Errors
                  </div>
                  <div className={`text-sm font-medium ${provider.errorCount > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                    {provider.errorCount}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
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
                    {provider.hourlyUsage.slice(-24).map((hour, i) => {
                      const maxCount = Math.max(...provider.hourlyUsage.map(h => h.requests), 1);
                      const height = (hour.requests / maxCount) * 100;
                      return (
                        <div
                          key={i}
                          className={`flex-1 rounded-t transition-all ${
                            hour.errors > 0 ? 'bg-red-400' : 'bg-purple-400'
                          }`}
                          style={{ height: `${Math.max(height, 2)}%` }}
                          title={`${hour.hour}: ${hour.requests} requests, ${hour.errors} errors`}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              {provider.topShops && provider.topShops.length > 0 && (
                <div>
                  <div className="text-xs text-gray-500 mb-2">Top Shops by Usage</div>
                  <div className="space-y-1">
                    {provider.topShops.slice(0, 3).map((shop, i) => (
                      <div key={shop.shopId} className="flex items-center justify-between text-sm">
                        <span className="text-gray-600">Shop #{shop.shopId}</span>
                        <span className="font-medium text-gray-900">{shop.count} req</span>
                      </div>
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
    </div>
  );
}
