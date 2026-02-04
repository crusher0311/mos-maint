"use client";

import { useState, useEffect, useCallback } from "react";

interface LogEntry {
  _id: string;
  logId: string;
  timestamp: string;
  level: string;
  message: string;
  serviceId: string;
  serviceName?: string;
  instanceId?: string;
  environment: string;
}

interface LogStats {
  total: number;
  byLevel: {
    error: number;
    warn: number;
    info: number;
    debug: number;
  };
}

interface ServiceInfo {
  serviceId: string;
  serviceName?: string;
}

interface ApiUsageStats {
  provider: string;
  total: number;
  errors: number;
  avgLatency: number;
  endpoints: { endpoint: string; count: number; errors: number }[];
}

type TabType = "logs" | "api-usage";

export default function ObservabilityPage() {
  const [activeTab, setActiveTab] = useState<TabType>("logs");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [hoursBack, setHoursBack] = useState(1);
  const [levelFilter, setLevelFilter] = useState<string>("");
  const [serviceFilter, setServiceFilter] = useState<string>("");
  const [envFilter, setEnvFilter] = useState<string>("");
  const [textSearch, setTextSearch] = useState<string>("");
  
  const [apiUsage, setApiUsage] = useState<ApiUsageStats[]>([]);
  const [apiLoading, setApiLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const params = new URLSearchParams();
      params.set("hours", hoursBack.toString());
      if (levelFilter) params.set("level", levelFilter);
      if (serviceFilter) params.set("serviceId", serviceFilter);
      if (envFilter) params.set("environment", envFilter);
      if (textSearch) params.set("text", textSearch);
      
      const response = await fetch(`/api/platform-admin/log-stream?${params}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to fetch logs");
      }
      
      const data = await response.json();
      setLogs(data.logs || []);
      setStats(data.stats || null);
      setEnvironments(data.environments || []);
      setServices(data.services || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [hoursBack, levelFilter, serviceFilter, envFilter, textSearch]);

  const fetchApiUsage = useCallback(async () => {
    setApiLoading(true);
    try {
      const response = await fetch(`/api/admin/api-usage/summary?hours=${hoursBack}`);
      if (response.ok) {
        const data = await response.json();
        setApiUsage(data.providers || []);
      }
    } catch (err) {
      console.error("Failed to fetch API usage:", err);
    } finally {
      setApiLoading(false);
    }
  }, [hoursBack]);

  useEffect(() => {
    if (activeTab === "logs") {
      fetchLogs();
    } else if (activeTab === "api-usage") {
      fetchApiUsage();
    }
  }, [activeTab, fetchLogs, fetchApiUsage]);

  const getLevelColor = (level: string) => {
    switch (level.toLowerCase()) {
      case "error": return "bg-red-100 text-red-800";
      case "warn":
      case "warning": return "bg-yellow-100 text-yellow-800";
      case "info": return "bg-blue-100 text-blue-800";
      case "debug": return "bg-gray-100 text-gray-600";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Platform Observability</h1>
        <p className="text-gray-500 mt-1">Monitor logs and API usage across environments</p>
      </div>

      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab("logs")}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "logs"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            Streamed Logs
          </button>
          <button
            onClick={() => setActiveTab("api-usage")}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "api-usage"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            API Usage
          </button>
        </nav>
      </div>

      {activeTab === "logs" && (
        <div>
          <div className="bg-white rounded-lg shadow p-4 mb-6">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Time Range</label>
                <select
                  value={hoursBack}
                  onChange={(e) => setHoursBack(Number(e.target.value))}
                  className="w-full border rounded-md px-3 py-2 text-sm"
                >
                  <option value={1}>Last 1 hour</option>
                  <option value={6}>Last 6 hours</option>
                  <option value={24}>Last 24 hours</option>
                  <option value={72}>Last 3 days</option>
                  <option value={168}>Last 7 days</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Level</label>
                <select
                  value={levelFilter}
                  onChange={(e) => setLevelFilter(e.target.value)}
                  className="w-full border rounded-md px-3 py-2 text-sm"
                >
                  <option value="">All Levels</option>
                  <option value="error">Error</option>
                  <option value="warn">Warning</option>
                  <option value="info">Info</option>
                  <option value="debug">Debug</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Environment</label>
                <select
                  value={envFilter}
                  onChange={(e) => setEnvFilter(e.target.value)}
                  className="w-full border rounded-md px-3 py-2 text-sm"
                >
                  <option value="">All Environments</option>
                  {environments.map(env => (
                    <option key={env} value={env}>{env}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Service</label>
                <select
                  value={serviceFilter}
                  onChange={(e) => setServiceFilter(e.target.value)}
                  className="w-full border rounded-md px-3 py-2 text-sm"
                >
                  <option value="">All Services</option>
                  {services.map(svc => (
                    <option key={svc.serviceId} value={svc.serviceId}>
                      {svc.serviceName || svc.serviceId}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
                <input
                  type="text"
                  value={textSearch}
                  onChange={(e) => setTextSearch(e.target.value)}
                  placeholder="Search logs..."
                  className="w-full border rounded-md px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-between items-center">
              <button
                onClick={fetchLogs}
                disabled={loading}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Loading..." : "Refresh"}
              </button>
              {stats && (
                <div className="flex gap-4 text-sm">
                  <span className="text-gray-600">Total: <strong>{stats.total}</strong></span>
                  <span className="text-red-600">Errors: <strong>{stats.byLevel.error}</strong></span>
                  <span className="text-yellow-600">Warnings: <strong>{stats.byLevel.warn}</strong></span>
                  <span className="text-blue-600">Info: <strong>{stats.byLevel.info}</strong></span>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
              <p className="text-red-800">{error}</p>
            </div>
          )}

          <div className="bg-white rounded-lg shadow overflow-hidden">
            {logs.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                {loading ? "Loading logs..." : "No logs found for the selected filters"}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Level</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Environment</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Service</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Message</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {logs.map((log) => (
                      <tr key={log._id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {new Date(log.timestamp).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getLevelColor(log.level)}`}>
                            {log.level.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {log.environment}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {log.serviceName || log.serviceId?.slice(0, 8)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900 max-w-xl truncate">
                          {log.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "api-usage" && (
        <div>
          <div className="bg-white rounded-lg shadow p-4 mb-6">
            <div className="flex items-center gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Time Range</label>
                <select
                  value={hoursBack}
                  onChange={(e) => setHoursBack(Number(e.target.value))}
                  className="border rounded-md px-3 py-2 text-sm"
                >
                  <option value={1}>Last 1 hour</option>
                  <option value={6}>Last 6 hours</option>
                  <option value={24}>Last 24 hours</option>
                  <option value={72}>Last 3 days</option>
                  <option value={168}>Last 7 days</option>
                </select>
              </div>
              <button
                onClick={fetchApiUsage}
                disabled={apiLoading}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 mt-6"
              >
                {apiLoading ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {apiUsage.map((provider) => (
              <div key={provider.provider} className="bg-white rounded-lg shadow p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">{provider.provider}</h3>
                <div className="space-y-2 mb-4">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Total Requests</span>
                    <span className="font-medium">{provider.total.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Errors</span>
                    <span className={`font-medium ${provider.errors > 0 ? "text-red-600" : "text-gray-900"}`}>
                      {provider.errors.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Avg Latency</span>
                    <span className="font-medium">{provider.avgLatency?.toFixed(0) || 0}ms</span>
                  </div>
                </div>
                {provider.endpoints && provider.endpoints.length > 0 && (
                  <div className="border-t pt-4">
                    <p className="text-sm font-medium text-gray-700 mb-2">Top Endpoints</p>
                    <div className="space-y-1">
                      {provider.endpoints.slice(0, 5).map((ep, idx) => (
                        <div key={idx} className="flex justify-between text-sm">
                          <span className="text-gray-500 truncate max-w-[180px]">{ep.endpoint}</span>
                          <span className="text-gray-900">{ep.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {apiUsage.length === 0 && !apiLoading && (
              <div className="col-span-full text-center py-8 text-gray-500">
                No API usage data found for the selected time range
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
