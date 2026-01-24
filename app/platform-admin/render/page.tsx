"use client";

import { useState, useEffect, useCallback } from "react";
import { 
  Activity, 
  AlertTriangle, 
  Clock, 
  RefreshCw,
  Server,
  ExternalLink,
  Filter,
  Search,
  ChevronDown,
  ChevronRight,
  XCircle,
  AlertCircle,
  Info
} from "lucide-react";

interface RenderLogEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  instanceId?: string;
  serviceId?: string;
  environment: string;
}

interface LogsData {
  logs: RenderLogEntry[];
  stats: {
    total: number;
    byLevel: {
      error: number;
      warn: number;
      info: number;
      debug: number;
    };
    byEnvironment: Record<string, number>;
  };
  hasMore: boolean;
  timeRange: {
    startTime: string;
    endTime: string;
  };
}

interface RenderService {
  id: string;
  name: string;
  type: string;
  suspended: string;
}

interface ServicesData {
  results: Array<{
    environment: string;
    services: RenderService[];
  }>;
}

export default function RenderObservabilityDashboard() {
  const [data, setData] = useState<LogsData | null>(null);
  const [services, setServices] = useState<ServicesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [hoursBack, setHoursBack] = useState(1);
  const [levelFilter, setLevelFilter] = useState<string>("");
  const [searchText, setSearchText] = useState("");
  const [environmentFilter, setEnvironmentFilter] = useState<string>("");
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [configError, setConfigError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        hours: hoursBack.toString(),
      });
      if (levelFilter) params.set('level', levelFilter);
      if (searchText) params.set('text', searchText);
      if (environmentFilter) params.set('environment', environmentFilter);

      const [logsRes, servicesRes] = await Promise.all([
        fetch(`/api/platform-admin/render-logs?${params}`),
        fetch('/api/platform-admin/render-logs?action=services')
      ]);

      const logsJson = await logsRes.json();
      const servicesJson = await servicesRes.json();

      if (logsJson.error) {
        setConfigError(logsJson.hint || logsJson.error);
        setData(null);
      } else {
        setConfigError(null);
        setData(logsJson);
      }

      if (!servicesJson.error) {
        setServices(servicesJson);
      }
    } catch (err) {
      console.error("Error loading Render data:", err);
    } finally {
      setLoading(false);
    }
  }, [hoursBack, levelFilter, searchText, environmentFilter]);

  useEffect(() => {
    loadData();
    
    if (autoRefresh) {
      const interval = setInterval(loadData, 30000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, loadData]);

  const toggleLogExpanded = (id: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const getLevelIcon = (level: string) => {
    switch (level.toLowerCase()) {
      case 'error':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'warn':
      case 'warning':
        return <AlertCircle className="w-4 h-4 text-amber-500" />;
      case 'info':
        return <Info className="w-4 h-4 text-blue-500" />;
      default:
        return <Activity className="w-4 h-4 text-gray-400" />;
    }
  };

  const getLevelBgColor = (level: string) => {
    switch (level.toLowerCase()) {
      case 'error':
        return 'bg-red-50 border-red-100';
      case 'warn':
      case 'warning':
        return 'bg-amber-50 border-amber-100';
      case 'info':
        return 'bg-blue-50 border-blue-100';
      default:
        return 'bg-gray-50 border-gray-100';
    }
  };

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-24 bg-gray-200 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (configError) {
    return (
      <div className="p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Render Observability</h1>
          <p className="text-gray-600">Monitor logs and deploys from your Render services</p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
          <div className="flex items-start gap-4">
            <AlertTriangle className="w-6 h-6 text-amber-600 flex-shrink-0" />
            <div>
              <h3 className="font-semibold text-amber-800">Configuration Required</h3>
              <p className="text-amber-700 mt-1">{configError}</p>
              <div className="mt-4 p-4 bg-white/50 rounded-lg text-sm">
                <p className="font-medium text-gray-800 mb-2">Required environment variables:</p>
                <ul className="space-y-1 text-gray-700">
                  <li><code className="bg-gray-100 px-1 rounded">RENDER_API_KEY_PROD</code> - Your Production Render API key</li>
                  <li><code className="bg-gray-100 px-1 rounded">RENDER_SERVICE_IDS_PROD</code> - Comma-separated service IDs for Production</li>
                  <li><code className="bg-gray-100 px-1 rounded">RENDER_API_KEY_QA</code> - Your QA Render API key (optional)</li>
                  <li><code className="bg-gray-100 px-1 rounded">RENDER_SERVICE_IDS_QA</code> - Comma-separated service IDs for QA (optional)</li>
                </ul>
                <p className="mt-3 text-gray-600">
                  Get your API key from{" "}
                  <a 
                    href="https://dashboard.render.com/u/settings" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline inline-flex items-center gap-1"
                  >
                    Render Account Settings <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Render Observability</h1>
          <p className="text-gray-600">Monitor logs and deploys from your Render services</p>
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

      {data?.stats && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Activity className="w-5 h-5 text-blue-600" />
              </div>
              <span className="text-sm text-gray-600">Total Logs</span>
            </div>
            <div className="text-2xl font-bold text-gray-900">
              {data.stats.total.toLocaleString()}
            </div>
          </div>

          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-red-100 rounded-lg">
                <XCircle className="w-5 h-5 text-red-600" />
              </div>
              <span className="text-sm text-gray-600">Errors</span>
            </div>
            <div className="text-2xl font-bold text-red-600">
              {data.stats.byLevel.error}
            </div>
          </div>

          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-amber-100 rounded-lg">
                <AlertCircle className="w-5 h-5 text-amber-600" />
              </div>
              <span className="text-sm text-gray-600">Warnings</span>
            </div>
            <div className="text-2xl font-bold text-amber-600">
              {data.stats.byLevel.warn}
            </div>
          </div>

          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Info className="w-5 h-5 text-blue-600" />
              </div>
              <span className="text-sm text-gray-600">Info</span>
            </div>
            <div className="text-2xl font-bold text-blue-600">
              {data.stats.byLevel.info}
            </div>
          </div>

          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-gray-100 rounded-lg">
                <Clock className="w-5 h-5 text-gray-600" />
              </div>
              <span className="text-sm text-gray-600">Time Range</span>
            </div>
            <div className="text-lg font-medium text-gray-900">
              Last {hoursBack}h
            </div>
          </div>
        </div>
      )}

      {services?.results && services.results.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <Server className="w-5 h-5" />
            Connected Services
          </h3>
          <div className="flex flex-wrap gap-2">
            {services.results.map(envResult => (
              envResult.services.map(service => (
                <div
                  key={`${envResult.environment}-${service.id}`}
                  className={`px-3 py-1.5 rounded-full text-sm flex items-center gap-2 ${
                    service.suspended === 'not_suspended' 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${
                    service.suspended === 'not_suspended' ? 'bg-green-500' : 'bg-gray-400'
                  }`} />
                  {service.name}
                  <span className="text-xs opacity-70">({envResult.environment})</span>
                </div>
              ))
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-400" />
            <select
              value={hoursBack}
              onChange={(e) => setHoursBack(parseInt(e.target.value))}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
            >
              <option value={1}>Last 1 hour</option>
              <option value={6}>Last 6 hours</option>
              <option value={24}>Last 24 hours</option>
              <option value={72}>Last 3 days</option>
            </select>
          </div>

          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">All Levels</option>
            <option value="error">Errors Only</option>
            <option value="warn">Warnings Only</option>
            <option value="info">Info Only</option>
          </select>

          {data?.stats.byEnvironment && Object.keys(data.stats.byEnvironment).length > 1 && (
            <select
              value={environmentFilter}
              onChange={(e) => setEnvironmentFilter(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
            >
              <option value="">All Environments</option>
              {Object.keys(data.stats.byEnvironment).map(env => (
                <option key={env} value={env}>{env}</option>
              ))}
            </select>
          )}

          <div className="flex-1 relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search logs..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadData()}
              className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-1.5 text-sm"
            />
          </div>

          <button
            onClick={loadData}
            className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium"
          >
            Apply Filters
          </button>
        </div>

        <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
          {data?.logs && data.logs.length > 0 ? (
            data.logs.map((log) => (
              <div
                key={log.id}
                className={`p-3 hover:bg-gray-50 cursor-pointer transition-colors ${getLevelBgColor(log.level)}`}
                onClick={() => toggleLogExpanded(log.id)}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 pt-0.5">
                    {expandedLogs.has(log.id) ? (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    )}
                  </div>
                  {getLevelIcon(log.level)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-gray-500 font-mono">
                        {formatTime(log.timestamp)}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        log.environment === 'Production' 
                          ? 'bg-purple-100 text-purple-700' 
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {log.environment}
                      </span>
                      <span className="text-xs uppercase font-medium text-gray-500">
                        {log.level}
                      </span>
                    </div>
                    <p className={`text-sm text-gray-800 ${
                      expandedLogs.has(log.id) ? 'whitespace-pre-wrap' : 'truncate'
                    }`}>
                      {log.message}
                    </p>
                    {expandedLogs.has(log.id) && log.instanceId && (
                      <p className="text-xs text-gray-500 mt-2">
                        Instance: {log.instanceId}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="p-12 text-center text-gray-500">
              <Activity className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p>No logs found for the selected filters</p>
            </div>
          )}
        </div>

        {data?.hasMore && (
          <div className="p-3 bg-gray-50 text-center text-sm text-gray-500 border-t border-gray-100">
            Showing first 500 logs. Narrow your search to see more specific results.
          </div>
        )}
      </div>

      {data?.timeRange && (
        <div className="text-center text-sm text-gray-500">
          Showing logs from {formatTime(data.timeRange.startTime)} to {formatTime(data.timeRange.endTime)}
        </div>
      )}
    </div>
  );
}
