"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import {
  ENTERPRISE_SETTING_CATEGORIES,
  ENTERPRISE_SETTING_CATEGORY_DETAILS,
  type EnterpriseSettingCategory,
} from "@/lib/enterprise-settings-catalog";

type CategoryKey = EnterpriseSettingCategory;

const CATEGORIES = ENTERPRISE_SETTING_CATEGORIES.map((key) => ({
  key,
  name: ENTERPRISE_SETTING_CATEGORY_DETAILS[key].label,
  description: ENTERPRISE_SETTING_CATEGORY_DETAILS[key].description,
}));

type Shop = { shopId: number; name: string; locationIdentifier?: string | null };
type User = {
  email: string;
  name: string | null;
  role: string;
  shopAccess: Array<{ shopId: number; shopName: string }>;
};
type UserData = {
  enterprise: { id: string; name: string };
  shops: Shop[];
  users: User[];
  currentUserRole?: string;
  canManageRoles?: boolean;
};
type CategoryStatus = {
  consistent?: boolean;
  matchingCount?: number;
  differingCount?: number;
  status?: string;
};
type CopyReport = {
  matchedCount?: number;
  updatedCount?: number;
  expectedCount?: number;
  failures?: Array<{ shopId?: number; shopName?: string; error?: string }>;
  results?: Array<{ shopId?: number; shopName?: string; success?: boolean; error?: string }>;
  message?: string;
};

function displayShop(shop: Shop) {
  return shop.locationIdentifier ? `${shop.name} (${shop.locationIdentifier})` : shop.name;
}

export default function EnterpriseSettingsPage() {
  const [data, setData] = useState<UserData | null>(null);
  const [sourceShopId, setSourceShopId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<CategoryKey>>(new Set(CATEGORIES.map((c) => c.key)));
  const [statuses, setStatuses] = useState<Partial<Record<CategoryKey, CategoryStatus>>>({});
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<CopyReport | null>(null);
  const [search, setSearch] = useState("");
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [userSaving, setUserSaving] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/dashboard/enterprise-users");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Failed to load enterprise");
    setData(result);
    setSourceShopId((current) => current ?? result.shops?.[0]?.shopId ?? null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadUsers();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load enterprise settings");
    } finally {
      setLoading(false);
    }
  }, [loadUsers]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!sourceShopId) return;
    let cancelled = false;
    setStatusLoading(true);
    fetch(`/api/enterprise/copy-settings?sourceShopId=${sourceShopId}&includeStatus=true`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Failed to load consistency status");
        if (cancelled) return;
        const incoming = result.categoryStatuses || result.statuses || result.consistency || {};
        setStatuses(incoming);
      })
      .catch((statusError) => {
        if (!cancelled) {
          setStatuses({});
          setError(statusError instanceof Error ? statusError.message : "Failed to load consistency status");
        }
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceShopId]);

  const destinations = useMemo(
    () => data?.shops.filter((shop) => shop.shopId !== sourceShopId) || [],
    [data, sourceShopId],
  );
  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.users || []).filter(
      (user) => !query || user.email.toLowerCase().includes(query) || user.name?.toLowerCase().includes(query),
    );
  }, [data, search]);

  const toggleCategory = (key: CategoryKey) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setReport(null);
  };

  const applyCopy = async () => {
    if (!sourceShopId || selected.size === 0) return;
    setCopying(true);
    setError(null);
    setReport(null);
    try {
      const response = await fetch("/api/enterprise/copy-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceShopId,
          settingTypes: [...selected],
          applyToAllLocations: true,
        }),
      });
      const result = await response.json();
      setReport(result);
       if (!response.ok || result.ok === false) {
         throw new Error(result.error || result.message || "Failed to copy enterprise settings");
       }
      setConfirming(false);
      await loadUsers();
      const statusResponse = await fetch(
        `/api/enterprise/copy-settings?sourceShopId=${sourceShopId}&includeStatus=true`,
      );
      const statusResult = await statusResponse.json();
      if (statusResponse.ok) {
        setStatuses(statusResult.categoryStatuses || statusResult.statuses || statusResult.consistency || {});
      }
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Failed to copy enterprise settings");
    } finally {
      setCopying(false);
    }
  };

  const updateUser = async (email: string, action: "grant" | "revoke" | "role", value: number | string) => {
    const key = `${email}-${action}-${value}`;
    setUserSaving(key);
    setError(null);
    try {
      const body =
        action === "role" ? { email, action, role: value } : { email, action, shopId: value };
      const response = await fetch("/api/dashboard/enterprise-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to update user");
      await loadUsers();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Failed to update user");
    } finally {
      setUserSaving(null);
    }
  };

  if (loading) {
    return <div className="flex min-h-[400px] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-blue-600" /></div>;
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-700">
          <AlertCircle className="mb-2 h-6 w-6" />
          <p>{error || "Unable to load enterprise settings."}</p>
          <button onClick={load} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-white">Try again</button>
        </div>
      </div>
    );
  }

  const sourceShop = data.shops.find((shop) => shop.shopId === sourceShopId);

  return (
    <div className="min-h-screen bg-gray-50 p-6 md:p-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <div>
          <Link href="/dashboard/enterprise" className="mb-4 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
            <ArrowLeft className="h-4 w-4" /> Back to Enterprise
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-blue-100 p-3"><Settings2 className="h-6 w-6 text-blue-600" /></div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Enterprise Settings</h1>
                <p className="text-gray-600">{data.enterprise.name} · Standardize locations and manage users</p>
              </div>
            </div>
            <button onClick={load} disabled={copying} className="inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
              <RefreshCw className="h-4 w-4" /> Reload
            </button>
          </div>
        </div>

        {error && <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
        {report && !error && (
          <div className={`rounded-lg border p-4 text-sm ${report.failures?.length || report.results?.some((r) => r.success === false) ? "border-amber-200 bg-amber-50 text-amber-800" : "border-green-200 bg-green-50 text-green-800"}`}>
            <div className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4" />{report.message || "Settings copied successfully"}</div>
            <p className="mt-1">
              Matched {report.matchedCount ?? report.expectedCount ?? destinations.length} · Updated {report.updatedCount ?? report.results?.filter((r) => r.success).length ?? destinations.length} · Failed {report.failures?.length ?? report.results?.filter((r) => r.success === false).length ?? 0}
            </p>
            {(report.failures || report.results?.filter((result) => result.success === false))?.map((failure, index) => (
              <p key={`${failure.shopId ?? failure.shopName ?? "failure"}-${index}`} className="mt-1">
                {failure.shopName || (failure.shopId ? `Shop ${failure.shopId}` : "Destination")}: {failure.error || "Update failed"}
              </p>
            ))}
          </div>
        )}

        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900">Copy location settings</h2>
            <p className="mt-1 text-sm text-gray-500">Choose the source of truth, then copy one, several, or all categories to every other location.</p>
          </div>
          <div className="space-y-6 p-6">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">Source location</label>
              <select
                value={sourceShopId ?? ""}
                onChange={(event) => { setSourceShopId(Number(event.target.value)); setReport(null); }}
                className="w-full max-w-xl rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
              >
                {data.shops.map((shop) => <option key={shop.shopId} value={shop.shopId}>{displayShop(shop)}</option>)}
              </select>
              <p className="mt-2 text-xs text-gray-500">{destinations.length} destination location{destinations.length === 1 ? "" : "s"} will receive the selected settings.</p>
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between gap-3">
                <label className="text-sm font-medium text-gray-700">Categories</label>
                <button
                  onClick={() => setSelected(selected.size === CATEGORIES.length ? new Set() : new Set(CATEGORIES.map((c) => c.key)))}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  {selected.size === CATEGORIES.length ? "Clear all" : "Select all"}
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {CATEGORIES.map((category) => {
                  const checked = selected.has(category.key);
                  const status = statuses[category.key];
                  const consistent = status?.consistent ?? status?.status === "consistent";
                  return (
                    <button
                      key={category.key}
                      type="button"
                      onClick={() => toggleCategory(category.key)}
                      className={`rounded-lg border p-4 text-left transition ${checked ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-gray-200 hover:border-gray-300"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium text-gray-900">{category.name}</span>
                        <span className={`flex h-5 w-5 items-center justify-center rounded border ${checked ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300"}`}>{checked && <Check className="h-3.5 w-3.5" />}</span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">{category.description}</p>
                      <div className="mt-3 text-xs">
                        {statusLoading ? <span className="text-gray-400">Checking…</span> : status ? (
                          <span className={consistent ? "text-green-700" : "text-amber-700"}>
                            {consistent ? "Consistent across locations" : `${status.differingCount ?? "Some"} location${status.differingCount === 1 ? "" : "s"} differ`}
                          </span>
                        ) : <span className="text-gray-400">Status unavailable</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end border-t border-gray-100 pt-5">
              <button
                onClick={() => setConfirming(true)}
                disabled={!sourceShopId || selected.size === 0 || destinations.length === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Copy className="h-4 w-4" /> Review and apply
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 p-6">
            <div className="flex items-center gap-2"><Users className="h-5 w-5 text-blue-600" /><h2 className="text-lg font-semibold text-gray-900">Enterprise users</h2></div>
            <p className="mt-1 text-sm text-gray-500">Search team members and manage access to enterprise locations.</p>
            <div className="relative mt-4 max-w-xl">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email" className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 focus:border-blue-500 focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="divide-y divide-gray-200">
            {filteredUsers.length === 0 ? <div className="p-8 text-center text-gray-500">No users match your search.</div> : filteredUsers.map((user) => {
              const open = expandedUser === user.email;
              const access = new Set(user.shopAccess.map((item) => item.shopId));
              return (
                <div key={user.email} className="p-4">
                  <button onClick={() => setExpandedUser(open ? null : user.email)} className="flex w-full items-center justify-between gap-4 text-left">
                    <div><p className="font-medium text-gray-900">{user.name || user.email}</p>{user.name && <p className="text-sm text-gray-500">{user.email}</p>}</div>
                    <div className="flex items-center gap-3"><span className="capitalize text-sm text-gray-600">{user.role}</span><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600">{user.shopAccess.length} location{user.shopAccess.length === 1 ? "" : "s"}</span></div>
                  </button>
                  {open && (
                    <div className="mt-4 space-y-4 border-l-2 border-gray-200 pl-4">
                      {data.canManageRoles && user.role !== "owner" && (
                        <div className="flex items-center justify-between rounded-lg border border-gray-200 p-3">
                          <div className="flex items-center gap-2 text-sm font-medium text-gray-700"><ShieldCheck className="h-4 w-4" />Enterprise role</div>
                          <select
                            value={user.role === "admin" ? "admin" : "user"}
                            disabled={userSaving !== null}
                            onChange={(e) => void updateUser(user.email, "role", e.target.value)}
                            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
                          >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                          </select>
                        </div>
                      )}
                      <div className="grid gap-2">
                        {data.shops.map((shop) => {
                          const hasAccess = access.has(shop.shopId);
                          const key = `${user.email}-${hasAccess ? "revoke" : "grant"}-${shop.shopId}`;
                          return (
                            <div key={shop.shopId} className={`flex items-center justify-between rounded-lg border p-3 ${hasAccess ? "border-green-200 bg-green-50" : "border-gray-200 bg-gray-50"}`}>
                              <div className="flex items-center gap-2 text-sm font-medium"><Building2 className="h-4 w-4 text-gray-400" />{displayShop(shop)}</div>
                              <button
                                disabled={userSaving !== null || (hasAccess && user.shopAccess.length <= 1)}
                                onClick={() => {
                                  if (hasAccess && !confirm(`Remove ${user.email}'s access to ${shop.name}?`)) return;
                                  void updateUser(user.email, hasAccess ? "revoke" : "grant", shop.shopId);
                                }}
                                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${hasAccess ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-blue-100 text-blue-700 hover:bg-blue-200"}`}
                              >
                                {userSaving === key ? <Loader2 className="h-3 w-3 animate-spin" /> : hasAccess ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                                {hasAccess ? "Revoke" : "Grant"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
            <div className="border-b border-gray-200 p-5"><h2 className="text-lg font-semibold text-gray-900">Replace settings at {destinations.length} locations?</h2></div>
            <div className="space-y-4 p-5 text-sm">
              <div><p className="text-xs font-medium uppercase tracking-wide text-gray-500">Source</p><p className="mt-1 font-medium text-gray-900">{sourceShop ? displayShop(sourceShop) : "Unknown"}</p></div>
              <div><p className="text-xs font-medium uppercase tracking-wide text-gray-500">Categories</p><p className="mt-1 text-gray-800">{CATEGORIES.filter((c) => selected.has(c.key)).map((c) => c.name).join(", ")}</p></div>
              <div><p className="text-xs font-medium uppercase tracking-wide text-gray-500">Destinations</p><p className="mt-1 text-gray-800">All {destinations.length} other enterprise locations</p></div>
              <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><p>This is destructive. Existing values in each selected category will be replaced by the source location&apos;s values, including empty lists or cleared values. Unselected categories remain unchanged.</p></div>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-200 p-5">
              <button disabled={copying} onClick={() => setConfirming(false)} className="rounded-lg px-4 py-2 text-gray-700 hover:bg-gray-100">Cancel</button>
              <button disabled={copying} onClick={() => void applyCopy()} className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 font-medium text-white hover:bg-red-700 disabled:opacity-50">{copying && <Loader2 className="h-4 w-4 animate-spin" />}Replace settings</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}