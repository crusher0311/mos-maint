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
  providerId?: string;
  total: number;
  errors: number;
  driftCount?: number;
  verifyOkCount?: number;
  tokensInWindow?: number;
  avgLatency: number;
  endpoints: { endpoint: string; count: number; errors: number; tokens?: number }[];
}

interface OpenAiSummary {
  tokensToday: number;
  topShopsByTokensToday: { shopId: number | null; tokens: number }[];
  utcDayStart: string;
}

interface CronBootEntry {
  status: "running" | "failed" | "disabled";
  bootedAt: string;
  instanceId?: string;
  host?: string;
  pid?: number;
  baseUrl?: string;
  jobsRegistered?: number;
  reason?: string;
  error?: string;
  jobs?: { name: string; schedule: string; method: string; path: string }[];
}

interface CronRunEntry {
  name: string;
  dt?: string;
  ok?: boolean;
  status?: number;
  ms?: number;
  error?: string | null;
  schedule?: string;
  instanceId?: string;
}

interface CronLockEntry {
  jobName: string;
  instanceId?: string;
  lockedAt?: string;
  expiresAt?: string;
}

interface CronStatusResponse {
  health: "ok" | "warn" | "fail";
  healthReason: string;
  lastBoot: CronBootEntry | null;
  sinceBootMs: number | null;
  bootHistory: CronBootEntry[];
  lastRuns: CronRunEntry[];
  activeLocks: CronLockEntry[];
}

type TabType = "logs" | "api-usage" | "cron";

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
  const [openAiSummary, setOpenAiSummary] = useState<OpenAiSummary | null>(null);
  const [apiLoading, setApiLoading] = useState(false);

  const [cronStatus, setCronStatus] = useState<CronStatusResponse | null>(null);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronError, setCronError] = useState<string | null>(null);

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
      const response = await fetch(`/api/platform-admin/api-usage/summary?hours=${hoursBack}`);
      if (response.ok) {
        const data = await response.json();
        setApiUsage(data.providers || []);
        setOpenAiSummary(data.openAi || null);
      }
    } catch (err) {
      console.error("Failed to fetch API usage:", err);
    } finally {
      setApiLoading(false);
    }
  }, [hoursBack]);

  const fetchCronStatus = useCallback(async () => {
    setCronLoading(true);
    setCronError(null);
    try {
      const response = await fetch(`/api/platform-admin/cron-status`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed (${response.status})`);
      }
      const data = (await response.json()) as CronStatusResponse;
      setCronStatus(data);
    } catch (err) {
      setCronError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCronLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "logs") {
      fetchLogs();
    } else if (activeTab === "api-usage") {
      fetchApiUsage();
    } else if (activeTab === "cron") {
      fetchCronStatus();
    }
  }, [activeTab, fetchLogs, fetchApiUsage, fetchCronStatus]);

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
          <button
            onClick={() => setActiveTab("cron")}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "cron"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            Cron Scheduler
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
                  {provider.providerId === "openai" && (provider.tokensInWindow ?? 0) > 0 ? (
                    <div className="flex justify-between">
                      <span className="text-gray-500" title="Sum of OpenAI tokens (prompt + completion) used in this time range">
                        Tokens (window)
                      </span>
                      <span className="font-medium text-gray-900">
                        {(provider.tokensInWindow ?? 0).toLocaleString()}
                      </span>
                    </div>
                  ) : null}
                  {provider.providerId === "openai" && openAiSummary ? (
                    <div className="flex justify-between">
                      <span className="text-gray-500" title="OpenAI tokens used since UTC midnight (drives the per-shop daily budget)">
                        Tokens today (UTC)
                      </span>
                      <span className="font-medium text-gray-900">
                        {openAiSummary.tokensToday.toLocaleString()}
                      </span>
                    </div>
                  ) : null}
                  {(provider.driftCount ?? 0) > 0 || (provider.verifyOkCount ?? 0) > 0 ? (
                    <div className="flex justify-between">
                      <span className="text-gray-500" title="Read-back verifications that detected the API silently dropped a field (e.g. logo not applied)">
                        Drift
                      </span>
                      <span className={`font-medium ${(provider.driftCount ?? 0) > 0 ? "text-yellow-600" : "text-gray-900"}`}>
                        {(provider.driftCount ?? 0).toLocaleString()}
                        {(provider.verifyOkCount ?? 0) > 0 && (
                          <span className="text-gray-400 text-xs ml-1">
                            / {((provider.driftCount ?? 0) + (provider.verifyOkCount ?? 0)).toLocaleString()}
                          </span>
                        )}
                      </span>
                    </div>
                  ) : null}
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

      {activeTab === "cron" && (
        <div>
          <div className="bg-white rounded-lg shadow p-4 mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium text-gray-700">In-process scheduler</h2>
              <p className="text-xs text-gray-500">
                Boot status and recent job runs are persisted to MongoDB so failures surface here even when production logs have rolled.
              </p>
            </div>
            <button
              onClick={fetchCronStatus}
              disabled={cronLoading}
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {cronLoading ? "Loading..." : "Refresh"}
            </button>
          </div>

          {cronError && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
              <p className="text-red-800">{cronError}</p>
            </div>
          )}

          {cronStatus && (
            <div className="space-y-6">
              <div
                className={`rounded-lg p-4 border ${
                  cronStatus.health === "ok"
                    ? "bg-green-50 border-green-200"
                    : cronStatus.health === "warn"
                    ? "bg-yellow-50 border-yellow-200"
                    : "bg-red-50 border-red-200"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`inline-block px-2 py-1 text-xs font-bold rounded ${
                      cronStatus.health === "ok"
                        ? "bg-green-600 text-white"
                        : cronStatus.health === "warn"
                        ? "bg-yellow-500 text-white"
                        : "bg-red-600 text-white"
                    }`}
                  >
                    {cronStatus.health.toUpperCase()}
                  </span>
                  <p className="text-sm font-medium text-gray-900">
                    {cronStatus.healthReason}
                  </p>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Last Boot
                </h3>
                {cronStatus.lastBoot ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                    <div>
                      <div className="text-gray-500">Status</div>
                      <div className="font-medium">
                        {cronStatus.lastBoot.status}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">Booted At</div>
                      <div className="font-medium">
                        {new Date(cronStatus.lastBoot.bootedAt).toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">Instance</div>
                      <div className="font-mono text-xs break-all">
                        {cronStatus.lastBoot.instanceId || cronStatus.lastBoot.host || "—"}
                      </div>
                    </div>
                    {typeof cronStatus.lastBoot.jobsRegistered === "number" && (
                      <div>
                        <div className="text-gray-500">Jobs Registered</div>
                        <div className="font-medium">
                          {cronStatus.lastBoot.jobsRegistered}
                        </div>
                      </div>
                    )}
                    {cronStatus.lastBoot.baseUrl && (
                      <div className="md:col-span-2">
                        <div className="text-gray-500">Base URL</div>
                        <div className="font-mono text-xs break-all">
                          {cronStatus.lastBoot.baseUrl}
                        </div>
                      </div>
                    )}
                    {cronStatus.lastBoot.reason && (
                      <div className="md:col-span-3">
                        <div className="text-gray-500">Reason</div>
                        <div className="text-sm">{cronStatus.lastBoot.reason}</div>
                      </div>
                    )}
                    {cronStatus.lastBoot.error && (
                      <div className="md:col-span-3">
                        <div className="text-gray-500">Error</div>
                        <div className="text-sm text-red-700 break-all whitespace-pre-wrap">
                          {cronStatus.lastBoot.error}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">
                    No boot record yet — scheduler has never reported.
                  </p>
                )}
              </div>

              <div className="bg-white rounded-lg shadow overflow-hidden">
                <div className="p-6 pb-2">
                  <h3 className="text-lg font-semibold text-gray-900">Last Job Runs</h3>
                </div>
                {cronStatus.lastRuns.length === 0 ? (
                  <div className="p-6 text-sm text-gray-500">
                    No job runs recorded yet.
                  </div>
                ) : (
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Job</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Run</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Result</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Latency</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Error</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {cronStatus.lastRuns.map((run) => (
                        <tr key={run.name} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">
                            {run.name}
                            {run.schedule && (
                              <span className="block text-xs text-gray-400 font-mono">
                                {run.schedule}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                            {run.dt ? new Date(run.dt).toLocaleString() : "—"}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span
                              className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                run.ok
                                  ? "bg-green-100 text-green-800"
                                  : "bg-red-100 text-red-800"
                              }`}
                            >
                              {run.ok ? "OK" : "FAIL"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {run.status || "—"}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {typeof run.ms === "number" ? `${run.ms}ms` : "—"}
                          </td>
                          <td className="px-4 py-3 text-sm text-red-700 max-w-xs truncate">
                            {run.error || ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {cronStatus.activeLocks.length > 0 && (
                <div className="bg-white rounded-lg shadow p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-3">
                    Active Locks
                  </h3>
                  <div className="space-y-2">
                    {cronStatus.activeLocks.map((lock) => (
                      <div
                        key={lock.jobName}
                        className="flex justify-between text-sm border-b last:border-b-0 pb-2"
                      >
                        <span className="font-medium">{lock.jobName}</span>
                        <span className="text-gray-500 font-mono text-xs">
                          {lock.instanceId} · expires{" "}
                          {lock.expiresAt
                            ? new Date(lock.expiresAt).toLocaleTimeString()
                            : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {cronStatus.bootHistory.length > 1 && (
                <div className="bg-white rounded-lg shadow p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-3">
                    Recent Boots
                  </h3>
                  <div className="space-y-2">
                    {cronStatus.bootHistory.slice(0, 10).map((boot, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between text-sm border-b last:border-b-0 pb-2"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={`inline-block px-2 py-0.5 text-xs font-semibold rounded ${
                              boot.status === "running"
                                ? "bg-green-100 text-green-800"
                                : boot.status === "disabled"
                                ? "bg-yellow-100 text-yellow-800"
                                : "bg-red-100 text-red-800"
                            }`}
                          >
                            {boot.status}
                          </span>
                          <span className="text-gray-600">
                            {new Date(boot.bootedAt).toLocaleString()}
                          </span>
                        </div>
                        <span className="text-xs text-gray-500 font-mono truncate max-w-xs">
                          {boot.error || boot.reason || boot.instanceId || boot.host || ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
