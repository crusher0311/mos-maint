"use client";

import { useState, useEffect, useCallback } from "react";

interface SnifferSession {
  id: number;
  uploadedBy: string;
  uploadedByEmail: string | null;
  platform: string | null;
  label: string | null;
  captureCount: number;
  createdAt: string;
}

interface Capture {
  id: string;
  timestamp: number;
  platform: string;
  categories: string[];
  method: string;
  url: string;
  path: string;
  requestHeaders: any;
  requestBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  source: string;
}

interface SessionDetail extends SnifferSession {
  captures: Capture[];
  totalCaptures: number;
  offset: number;
  limit: number;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-blue-600 text-white",
  POST: "bg-green-600 text-white",
  PUT: "bg-yellow-600 text-white",
  PATCH: "bg-purple-600 text-white",
  DELETE: "bg-red-600 text-white",
};

const CATEGORY_COLORS: Record<string, string> = {
  dvi: "bg-red-100 text-red-700",
  estimates: "bg-yellow-100 text-yellow-700",
  scheduling: "bg-blue-100 text-blue-700",
  communication: "bg-purple-100 text-purple-700",
  authorization: "bg-green-100 text-green-700",
  customers: "bg-teal-100 text-teal-700",
  vehicles: "bg-indigo-100 text-indigo-700",
  repair_orders: "bg-orange-100 text-orange-700",
};

function formatDate(dt: string): string {
  try {
    return new Date(dt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return dt;
  }
}

function formatJSON(data: any): string {
  if (!data) return "";
  if (typeof data === "string") {
    try {
      return JSON.stringify(JSON.parse(data), null, 2);
    } catch {
      return data;
    }
  }
  return JSON.stringify(data, null, 2);
}

export default function SnifferViewerPage() {
  const [sessions, setSessions] = useState<SnifferSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedCapture, setExpandedCapture] = useState<string | null>(null);
  const [filterMethod, setFilterMethod] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [search, setSearch] = useState("");

  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/platform-admin/sniffer");
      if (!res.ok) throw new Error("Failed to fetch sessions");
      const data = await res.json();
      setSessions(data.sessions);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const loadSession = async (id: number, offset = 0, append = false) => {
    try {
      if (!append) setDetailLoading(true);
      setExpandedCapture(null);
      const res = await fetch(
        `/api/platform-admin/sniffer/${id}?offset=${offset}&limit=50`
      );
      if (!res.ok) throw new Error("Failed to load session");
      const data = await res.json();
      if (append && selectedSession) {
        setSelectedSession({
          ...data.session,
          captures: [...selectedSession.captures, ...data.session.captures],
        });
      } else {
        setSelectedSession(data.session);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDetailLoading(false);
    }
  };

  const loadMore = () => {
    if (!selectedSession) return;
    const nextOffset = selectedSession.captures.length;
    if (nextOffset >= selectedSession.totalCaptures) return;
    loadSession(selectedSession.id, nextOffset, true);
  };

  const deleteSession = async (id: number) => {
    if (!confirm("Delete this sniffer session?")) return;
    try {
      const res = await fetch(`/api/platform-admin/sniffer/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete session");
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (selectedSession?.id === id) setSelectedSession(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const filteredCaptures = selectedSession?.captures?.filter((c) => {
    if (filterMethod && c.method !== filterMethod) return false;
    if (filterCategory && !c.categories?.includes(filterCategory)) return false;
    if (search) {
      const q = search.toLowerCase();
      const matchUrl = c.url?.toLowerCase().includes(q);
      const matchPath = c.path?.toLowerCase().includes(q);
      const matchBody =
        c.requestBody?.toLowerCase().includes(q) ||
        c.responseBody?.toLowerCase().includes(q);
      if (!matchUrl && !matchPath && !matchBody) return false;
    }
    return true;
  }) || [];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">API Sniffer Captures</h1>
            <p className="text-sm text-gray-500 mt-1">
              Review API traffic uploaded from the Detect Dog extension
            </p>
          </div>
          <button
            onClick={fetchSessions}
            className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-red-700 text-sm">
            {error}
            <button
              onClick={() => setError("")}
              className="ml-2 text-red-500 hover:text-red-700"
            >
              ✕
            </button>
          </div>
        )}

        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-4">
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
              <div className="p-4 border-b border-gray-200">
                <h2 className="font-semibold text-gray-900 text-sm">
                  Upload Sessions ({sessions.length})
                </h2>
              </div>
              {loading ? (
                <div className="p-8 text-center text-gray-400">Loading...</div>
              ) : sessions.length === 0 ? (
                <div className="p-8 text-center text-gray-400 text-sm">
                  No sniffer sessions uploaded yet.
                  <br />
                  Use the extension's API Sniffer to capture and upload.
                </div>
              ) : (
                <div className="divide-y divide-gray-100 max-h-[calc(100vh-240px)] overflow-y-auto">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      className={`p-3 cursor-pointer hover:bg-gray-50 transition-colors ${
                        selectedSession?.id === s.id ? "bg-blue-50 border-l-2 border-blue-500" : ""
                      }`}
                      onClick={() => loadSession(s.id)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-900 truncate flex-1">
                          {s.label || `Session #${s.id}`}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSession(s.id);
                          }}
                          className="ml-2 text-gray-400 hover:text-red-500 text-xs"
                          title="Delete session"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        {s.platform && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                            {s.platform}
                          </span>
                        )}
                        <span className="text-xs text-gray-500">
                          {s.captureCount} captures
                        </span>
                      </div>
                      <div className="text-xs text-gray-400 mt-1">
                        {formatDate(s.createdAt)} · {s.uploadedByEmail || s.uploadedBy}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="col-span-8">
            {detailLoading ? (
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-8 text-center text-gray-400">
                Loading session...
              </div>
            ) : !selectedSession ? (
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-12 text-center text-gray-400">
                <div className="text-4xl mb-3">📡</div>
                <div className="text-sm">Select a session to view captures</div>
              </div>
            ) : (
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="p-4 border-b border-gray-200">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-semibold text-gray-900">
                      {selectedSession.label || `Session #${selectedSession.id}`}
                    </h2>
                    <span className="text-xs text-gray-400">
                      {formatDate(selectedSession.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={filterMethod}
                      onChange={(e) => setFilterMethod(e.target.value)}
                      className="text-xs border border-gray-300 rounded px-2 py-1"
                    >
                      <option value="">All Methods</option>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="PATCH">PATCH</option>
                      <option value="DELETE">DELETE</option>
                    </select>
                    <select
                      value={filterCategory}
                      onChange={(e) => setFilterCategory(e.target.value)}
                      className="text-xs border border-gray-300 rounded px-2 py-1"
                    >
                      <option value="">All Categories</option>
                      <option value="dvi">DVI</option>
                      <option value="estimates">Estimates</option>
                      <option value="scheduling">Scheduling</option>
                      <option value="customers">Customers</option>
                      <option value="vehicles">Vehicles</option>
                      <option value="repair_orders">Repair Orders</option>
                      <option value="communication">Communication</option>
                      <option value="authorization">Authorization</option>
                    </select>
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search URL or body..."
                      className="text-xs border border-gray-300 rounded px-2 py-1 w-48"
                    />
                    <span className="text-xs text-gray-400 ml-auto">
                      {filteredCaptures.length} / {selectedSession.captures?.length || 0} captures
                    </span>
                  </div>
                </div>

                <div className="divide-y divide-gray-100 max-h-[calc(100vh-340px)] overflow-y-auto">
                  {filteredCaptures.length === 0 ? (
                    <div className="p-8 text-center text-gray-400 text-sm">
                      No captures match the current filters.
                    </div>
                  ) : (
                    filteredCaptures.map((c) => {
                      const isExpanded = expandedCapture === c.id;
                      const statusColor =
                        c.responseStatus && c.responseStatus < 300
                          ? "text-green-600"
                          : c.responseStatus && c.responseStatus < 400
                          ? "text-yellow-600"
                          : "text-red-600";

                      return (
                        <div key={c.id}>
                          <div
                            className="px-4 py-3 flex items-center gap-2 cursor-pointer hover:bg-gray-50 transition-colors"
                            onClick={() =>
                              setExpandedCapture(isExpanded ? null : c.id)
                            }
                          >
                            <span
                              className={`text-xs transform transition-transform ${
                                isExpanded ? "rotate-90" : ""
                              } text-gray-400`}
                            >
                              ▶
                            </span>
                            <span
                              className={`text-xs font-bold px-2 py-0.5 rounded ${
                                METHOD_COLORS[c.method] || "bg-gray-500 text-white"
                              }`}
                            >
                              {c.method}
                            </span>
                            <span
                              className="text-sm font-mono text-gray-700 truncate flex-1"
                              title={c.url}
                            >
                              {c.path}
                            </span>
                            {c.categories?.map((cat) => (
                              <span
                                key={cat}
                                className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                                  CATEGORY_COLORS[cat] || "bg-gray-100 text-gray-600"
                                }`}
                              >
                                {cat}
                              </span>
                            ))}
                            <span className={`text-xs font-mono font-semibold ${statusColor}`}>
                              {c.responseStatus || "—"}
                            </span>
                            <span className="text-xs text-gray-400">
                              {c.timestamp
                                ? new Date(c.timestamp).toLocaleTimeString("en-US", {
                                    hour12: false,
                                  })
                                : ""}
                            </span>
                          </div>

                          {isExpanded && (
                            <div className="bg-gray-50 border-t border-gray-100 px-4 py-3 space-y-3">
                              <div>
                                <div className="text-xs font-semibold text-gray-500 uppercase mb-1">
                                  Full URL
                                </div>
                                <div className="bg-white border border-gray-200 rounded p-2 text-xs font-mono break-all">
                                  {c.url}
                                </div>
                              </div>
                              {c.requestHeaders && (
                                <div>
                                  <div className="text-xs font-semibold text-gray-500 uppercase mb-1">
                                    Request Headers
                                  </div>
                                  <pre className="bg-white border border-gray-200 rounded p-2 text-xs font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                                    {formatJSON(c.requestHeaders)}
                                  </pre>
                                </div>
                              )}
                              {c.requestBody && (
                                <div>
                                  <div className="text-xs font-semibold text-gray-500 uppercase mb-1">
                                    Request Body
                                  </div>
                                  <pre className="bg-white border border-gray-200 rounded p-2 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
                                    {formatJSON(c.requestBody)}
                                  </pre>
                                </div>
                              )}
                              {c.responseBody && (
                                <div>
                                  <div className="text-xs font-semibold text-gray-500 uppercase mb-1">
                                    Response Body
                                  </div>
                                  <pre className="bg-white border border-gray-200 rounded p-2 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
                                    {formatJSON(c.responseBody)}
                                  </pre>
                                </div>
                              )}
                              {c.source && (
                                <div className="text-xs text-gray-400">
                                  Source: {c.source} · Platform: {c.platform}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                  {selectedSession &&
                    selectedSession.captures.length <
                      selectedSession.totalCaptures && (
                      <div className="p-4 text-center border-t border-gray-100">
                        <button
                          onClick={loadMore}
                          className="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg text-sm font-medium hover:bg-blue-100"
                        >
                          Load More ({selectedSession.totalCaptures - selectedSession.captures.length} remaining)
                        </button>
                      </div>
                    )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
