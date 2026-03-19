"use client";

import { useState, useEffect, useCallback } from "react";

interface ServiceKey {
  key: string;
  count: number;
  samples: string[];
  buckets: Record<string, number>;
  isComplimentary: boolean;
  isMisc: boolean;
  isProtractor: boolean;
}

interface UnmappedItem {
  name: string;
  count: number;
  vins: string[];
  bucket: string;
}

interface ServiceKeysData {
  totalPlansScanned: number;
  totalKeys: number;
  keys: ServiceKey[];
  unmapped: UnmappedItem[];
}

export default function ServiceKeysPage() {
  const [data, setData] = useState<ServiceKeysData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "standard" | "misc" | "protractor" | "complimentary">("all");
  const [search, setSearch] = useState("");
  const [shopId, setShopId] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [tab, setTab] = useState<"mapped" | "unmapped">("mapped");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (shopId) params.set("shopId", shopId);
      const res = await fetch(`/api/platform-admin/service-keys?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredKeys = data?.keys.filter((k) => {
    if (filter === "standard" && (k.isMisc || k.isProtractor || k.isComplimentary)) return false;
    if (filter === "misc" && !k.isMisc) return false;
    if (filter === "protractor" && !k.isProtractor) return false;
    if (filter === "complimentary" && !k.isComplimentary) return false;
    if (search) {
      const s = search.toLowerCase();
      return k.key.toLowerCase().includes(s) || k.samples.some((sample) => sample.toLowerCase().includes(s));
    }
    return true;
  }) || [];

  const filteredUnmapped = data?.unmapped.filter((u) => {
    if (!search) return true;
    return u.name.toLowerCase().includes(search.toLowerCase());
  }) || [];

  const stats = data ? {
    standard: data.keys.filter((k) => !k.isMisc && !k.isProtractor && !k.isComplimentary).length,
    misc: data.keys.filter((k) => k.isMisc).length,
    protractor: data.keys.filter((k) => k.isProtractor).length,
    complimentary: data.keys.filter((k) => k.isComplimentary).length,
  } : null;

  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "8px" }}>Service Key Explorer</h1>
      <p style={{ color: "#666", marginBottom: "24px" }}>
        Browse all service keys used in cached maintenance plans. See how OEM items map to internal keys, find unmapped items, and identify opportunities for better mapping.
      </p>

      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px", color: "#555" }}>Shop ID (optional)</label>
          <input
            type="text"
            placeholder="All shops"
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchData()}
            style={{ padding: "8px 12px", border: "1px solid #ddd", borderRadius: "6px", width: "140px" }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px", color: "#555" }}>Search</label>
          <input
            type="text"
            placeholder="Search keys or item names..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid #ddd", borderRadius: "6px", width: "260px" }}
          />
        </div>
        <button
          onClick={fetchData}
          style={{ padding: "8px 16px", background: "#2563eb", color: "white", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 600, height: "38px" }}
        >
          Refresh
        </button>
      </div>

      {loading && <p>Loading service keys...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {data && !loading && (
        <>
          <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
            <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "8px", padding: "12px 16px", minWidth: "120px" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#0369a1" }}>{data.totalPlansScanned}</div>
              <div style={{ fontSize: "12px", color: "#555" }}>Plans Scanned</div>
            </div>
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "12px 16px", minWidth: "120px" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#15803d" }}>{stats?.standard}</div>
              <div style={{ fontSize: "12px", color: "#555" }}>Standard Keys</div>
            </div>
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", padding: "12px 16px", minWidth: "120px" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#a16207" }}>{stats?.misc}</div>
              <div style={{ fontSize: "12px", color: "#555" }}>Misc Keys</div>
            </div>
            <div style={{ background: "#fdf4ff", border: "1px solid #e9d5ff", borderRadius: "8px", padding: "12px 16px", minWidth: "120px" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#7e22ce" }}>{stats?.protractor}</div>
              <div style={{ fontSize: "12px", color: "#555" }}>Protractor Keys</div>
            </div>
            <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "8px", padding: "12px 16px", minWidth: "120px" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#c2410c" }}>{data.unmapped.length}</div>
              <div style={{ fontSize: "12px", color: "#555" }}>Unmapped Items</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "2px", marginBottom: "16px", background: "#f1f5f9", borderRadius: "8px", padding: "2px" }}>
            <button
              onClick={() => setTab("mapped")}
              style={{
                padding: "8px 20px", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 600,
                background: tab === "mapped" ? "white" : "transparent",
                color: tab === "mapped" ? "#1e293b" : "#64748b",
                boxShadow: tab === "mapped" ? "0 1px 3px rgba(0,0,0,0.1)" : "none"
              }}
            >
              Mapped Keys ({data.totalKeys})
            </button>
            <button
              onClick={() => setTab("unmapped")}
              style={{
                padding: "8px 20px", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 600,
                background: tab === "unmapped" ? "white" : "transparent",
                color: tab === "unmapped" ? "#1e293b" : "#64748b",
                boxShadow: tab === "unmapped" ? "0 1px 3px rgba(0,0,0,0.1)" : "none"
              }}
            >
              Unmapped Items ({data.unmapped.length})
            </button>
          </div>

          {tab === "mapped" && (
            <>
              <div style={{ display: "flex", gap: "6px", marginBottom: "16px", flexWrap: "wrap" }}>
                {(["all", "standard", "misc", "protractor", "complimentary"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: "4px 14px", border: "1px solid #e2e8f0", borderRadius: "20px", cursor: "pointer",
                      fontSize: "13px", fontWeight: 500,
                      background: filter === f ? "#2563eb" : "white",
                      color: filter === f ? "white" : "#475569",
                    }}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {filteredKeys.map((k) => (
                  <div
                    key={k.key}
                    style={{
                      border: "1px solid #e2e8f0", borderRadius: "8px", overflow: "hidden",
                      background: expandedKey === k.key ? "#f8fafc" : "white"
                    }}
                  >
                    <div
                      onClick={() => setExpandedKey(expandedKey === k.key ? null : k.key)}
                      style={{
                        padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: "12px",
                        justifyContent: "space-between"
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1 }}>
                        <code style={{
                          background: k.isMisc ? "#fef3c7" : k.isProtractor ? "#f3e8ff" : k.isComplimentary ? "#fef3c7" : "#ecfdf5",
                          color: k.isMisc ? "#92400e" : k.isProtractor ? "#6b21a8" : k.isComplimentary ? "#92400e" : "#065f46",
                          padding: "2px 8px", borderRadius: "4px", fontSize: "13px", fontWeight: 600
                        }}>
                          {k.key}
                        </code>
                        <span style={{ color: "#94a3b8", fontSize: "13px" }}>
                          {k.samples.slice(0, 2).join(", ")}
                          {k.samples.length > 2 && ` +${k.samples.length - 2} more`}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        {Object.entries(k.buckets).map(([bucket, count]) => (
                          <span key={bucket} style={{
                            fontSize: "11px", padding: "2px 8px", borderRadius: "10px", fontWeight: 600,
                            background: bucket === "overdue" ? "#fef2f2" : bucket === "dueSoon" ? "#fffbeb" : "#f0f9ff",
                            color: bucket === "overdue" ? "#dc2626" : bucket === "dueSoon" ? "#d97706" : "#2563eb",
                          }}>
                            {bucket}: {count}
                          </span>
                        ))}
                        <span style={{ fontSize: "14px", fontWeight: 700, color: "#334155", minWidth: "50px", textAlign: "right" }}>
                          {k.count}
                        </span>
                      </div>
                    </div>
                    {expandedKey === k.key && (
                      <div style={{ padding: "0 16px 12px", borderTop: "1px solid #e2e8f0" }}>
                        <div style={{ fontSize: "12px", fontWeight: 600, color: "#64748b", margin: "12px 0 6px" }}>
                          Sample Item Names ({k.samples.length})
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                          {k.samples.map((s, i) => (
                            <span key={i} style={{
                              background: "#f1f5f9", padding: "4px 10px", borderRadius: "4px",
                              fontSize: "13px", color: "#334155"
                            }}>
                              {s}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {filteredKeys.length === 0 && (
                  <p style={{ color: "#94a3b8", textAlign: "center", padding: "20px" }}>No keys match your filters.</p>
                )}
              </div>
            </>
          )}

          {tab === "unmapped" && (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#475569", borderBottom: "1px solid #e2e8f0" }}>Item Name</th>
                    <th style={{ padding: "10px 16px", textAlign: "center", fontWeight: 600, color: "#475569", borderBottom: "1px solid #e2e8f0", width: "80px" }}>Count</th>
                    <th style={{ padding: "10px 16px", textAlign: "center", fontWeight: 600, color: "#475569", borderBottom: "1px solid #e2e8f0", width: "100px" }}>Bucket</th>
                    <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#475569", borderBottom: "1px solid #e2e8f0" }}>Example VINs</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUnmapped.map((u, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "8px 16px", color: "#1e293b" }}>{u.name}</td>
                      <td style={{ padding: "8px 16px", textAlign: "center", fontWeight: 600 }}>{u.count}</td>
                      <td style={{ padding: "8px 16px", textAlign: "center" }}>
                        <span style={{
                          fontSize: "11px", padding: "2px 8px", borderRadius: "10px", fontWeight: 600,
                          background: u.bucket === "overdue" ? "#fef2f2" : u.bucket === "dueSoon" ? "#fffbeb" : "#f0f9ff",
                          color: u.bucket === "overdue" ? "#dc2626" : u.bucket === "dueSoon" ? "#d97706" : "#2563eb",
                        }}>
                          {u.bucket}
                        </span>
                      </td>
                      <td style={{ padding: "8px 16px" }}>
                        <code style={{ fontSize: "11px", color: "#64748b" }}>{u.vins.join(", ")}</code>
                      </td>
                    </tr>
                  ))}
                  {filteredUnmapped.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ padding: "20px", textAlign: "center", color: "#94a3b8" }}>
                        No unmapped items found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
