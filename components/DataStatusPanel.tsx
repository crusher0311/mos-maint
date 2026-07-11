"use client";

import { useEffect, useState } from "react";
import {
  RefreshCw,
  RotateCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  HelpCircle,
  Database,
  ShieldCheck,
} from "lucide-react";

// Client-facing "Data Status" panel (task #629). Proves to a shop that their
// synced data is complete and continuously kept fresh. Used on the client
// Integrations settings page and reused (with an explicit shopId) in the
// platform-admin per-shop view. Read-only and resilient: it degrades to a
// loading / unknown / error state without blocking the host page.

type FreshnessState = "fresh" | "aging" | "stale" | "unknown";

interface DataStatusEntity {
  key: string;
  label: string;
  available: boolean;
  count: number | null;
  oldest: string | null;
  newest: string | null;
  lastUpdated: string | null;
  freshness: FreshnessState;
  note?: string | null;
}

type ResyncStatus = "queued" | "processing" | "completed" | "failed";

interface ProviderLocation {
  name: string | null;
  street: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  phone: string | null;
  timeZone: string | null;
}

interface ConnectionIdentity {
  provider: {
    label: string;
    connectedAt: string | null;
    shopName: string | null;
    providerShopId: string | null;
    connectionIdMasked: string | null;
    apiKeyMasked: string | null;
    locations: ProviderLocation[];
  } | null;
  carfax: {
    configured: boolean;
    locationId: string | null;
    lastCallAt: string | null;
    lastCallOk: boolean | null;
  };
}

interface DataStatusResponse {
  shopId: number;
  connection: {
    connected: boolean;
    provider: string | null;
    providerLabel: string | null;
    lastSyncAt: string | null;
  };
  identity?: ConnectionIdentity;
  entities: DataStatusEntity[];
  resync?: {
    available: boolean;
    status: ResyncStatus | null;
    requestedAt: string | null;
    scheduledFor: string | null;
    processedAt: string | null;
  };
  generatedAt: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return formatDate(iso);
}

const FRESHNESS_META: Record<
  FreshnessState,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  fresh: {
    label: "Up to date",
    className: "bg-green-100 text-green-700",
    Icon: CheckCircle2,
  },
  aging: {
    label: "A few days old",
    className: "bg-amber-100 text-amber-700",
    Icon: Clock,
  },
  stale: {
    label: "Needs attention",
    className: "bg-red-100 text-red-700",
    Icon: AlertTriangle,
  },
  unknown: {
    label: "Checking…",
    className: "bg-gray-100 text-gray-500",
    Icon: HelpCircle,
  },
};

function FreshnessBadge({ state }: { state: FreshnessState }) {
  const meta = FRESHNESS_META[state];
  const { Icon } = meta;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${meta.className}`}
    >
      <Icon className="w-3 h-3" />
      {meta.label}
    </span>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-500 whitespace-nowrap">{label}</dt>
      <dd className="text-gray-800 text-right font-medium">{value}</dd>
    </div>
  );
}

// "Connection details" — the location + API identity we have on file for
// this shop, so a client can confirm MOS is connected to the CORRECT shop
// (right Protractor location, right CARFAX Location ID, …).
function ConnectionDetails({ identity }: { identity: ConnectionIdentity }) {
  const p = identity.provider;
  const cf = identity.carfax;
  if (!p && !cf.configured) return null;

  return (
    <div className="mb-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
      {p && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-900">
              {p.label} connection
            </span>
            {p.connectedAt && (
              <span className="text-xs text-gray-400">
                Connected {formatDate(p.connectedAt)}
              </span>
            )}
          </div>
          <dl className="space-y-1 text-xs">
            <DetailRow label="Shop name" value={p.shopName} />
            <DetailRow label={`${p.label} shop ID`} value={p.providerShopId} />
            <DetailRow label="Connection ID" value={p.connectionIdMasked} />
            <DetailRow label="API key" value={p.apiKeyMasked} />
          </dl>
          {p.locations.length > 0 && (
            <div className="mt-2 space-y-2">
              {p.locations.map((loc, i) => (
                <div
                  key={i}
                  className="rounded-md bg-white border border-gray-200 p-2.5 text-xs"
                >
                  <p className="font-medium text-gray-900">
                    {loc.name || "Location"}
                  </p>
                  {(loc.street || loc.city) && (
                    <p className="text-gray-600">
                      {[loc.street, loc.city, loc.province, loc.postalCode]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  )}
                  <p className="text-gray-500">
                    {[loc.phone, loc.timeZone].filter(Boolean).join(" · ")}
                  </p>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-gray-400">
            As reported by {p.label} when this shop was connected.
          </p>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-gray-900">
            CARFAX connection
          </span>
          {cf.configured ? (
            cf.lastCallOk === null ? null : cf.lastCallOk ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                <CheckCircle2 className="w-3 h-3" />
                Working
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                <AlertTriangle className="w-3 h-3" />
                Last call failed
              </span>
            )
          ) : (
            <span className="text-xs text-gray-400">Not set up</span>
          )}
        </div>
        {cf.configured ? (
          <dl className="space-y-1 text-xs">
            <DetailRow label="Location ID" value={cf.locationId} />
            <DetailRow
              label="Last CARFAX lookup"
              value={cf.lastCallAt ? formatRelative(cf.lastCallAt) : null}
            />
          </dl>
        ) : (
          <p className="text-xs text-gray-500">
            No CARFAX Location ID on file for this shop. Add one in the CARFAX
            card above to pull service history.
          </p>
        )}
        {cf.configured && (
          <p className="mt-2 text-[11px] text-gray-400">
            Confirm this Location ID matches the one CARFAX assigned to this
            physical location.
          </p>
        )}
      </div>
    </div>
  );
}

function EntityCard({ entity }: { entity: DataStatusEntity }) {
  if (!entity.available) {
    return (
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="font-medium text-gray-700">{entity.label}</span>
          <span className="text-xs text-gray-400">Not synced</span>
        </div>
        <p className="text-xs text-gray-400">
          {entity.note || "Your shop system doesn't share this with MOS."}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-medium text-gray-900">{entity.label}</span>
        <FreshnessBadge state={entity.freshness} />
      </div>
      <div className="text-2xl font-semibold text-gray-900 mb-2">
        {entity.count === null ? "—" : entity.count.toLocaleString()}
      </div>
      <dl className="space-y-1 text-xs text-gray-500">
        <div className="flex justify-between">
          <dt>Oldest record</dt>
          <dd className="text-gray-700">{formatDate(entity.oldest)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Newest record</dt>
          <dd className="text-gray-700">{formatDate(entity.newest)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Last updated</dt>
          <dd className="text-gray-700">
            {formatRelative(entity.lastUpdated)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default function DataStatusPanel({
  shopId,
  className = "",
}: {
  // Omit for the caller's own shop (client view). Platform-admin views pass
  // an explicit shopId.
  shopId?: number | string;
  className?: string;
}) {
  const [data, setData] = useState<DataStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);

  const requestResync = async () => {
    setResyncing(true);
    setResyncMsg(null);
    try {
      const url = shopId
        ? `/api/settings/data-status/resync?shopId=${encodeURIComponent(String(shopId))}`
        : "/api/settings/data-status/resync";
      const res = await fetch(url, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResyncMsg({
          kind: res.status === 429 ? "info" : "error",
          text:
            json?.message || `Couldn't schedule a re-sync (${res.status}).`,
        });
      } else {
        setResyncMsg({
          kind: "info",
          text:
            json?.message ||
            "We'll re-sync your full history overnight.",
        });
        await load();
      }
    } catch (err: any) {
      setResyncMsg({
        kind: "error",
        text: err?.message || "Couldn't schedule a re-sync.",
      });
    } finally {
      setResyncing(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = shopId
        ? `/api/settings/data-status?shopId=${encodeURIComponent(String(shopId))}`
        : "/api/settings/data-status";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      const json = (await res.json()) as DataStatusResponse;
      setData(json);
    } catch (err: any) {
      setError(err?.message || "Could not load data status");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  return (
    <section
      className={`bg-white rounded-xl border border-gray-200 p-5 ${className}`}
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-gray-700" />
          <h3 className="text-lg font-semibold text-gray-900">Data Status</h3>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        A live look at the shop data we've synced and how fresh it is.
      </p>

      {/* Connection status row */}
      {data && (
        <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
          {data.connection.connected ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-50 text-green-700 font-medium">
              <CheckCircle2 className="w-4 h-4" />
              Connected to {data.connection.providerLabel}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gray-100 text-gray-600 font-medium">
              <AlertTriangle className="w-4 h-4" />
              No shop system connected
            </span>
          )}
          {data.connection.lastSyncAt && (
            <span className="text-gray-500">
              Last sync {formatRelative(data.connection.lastSyncAt)}
            </span>
          )}
        </div>
      )}

      {/* Connection identity — which exact shop/location we're wired to */}
      {data?.identity && <ConnectionDetails identity={data.identity} />}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}{" "}
          <button onClick={load} className="underline font-medium">
            Try again
          </button>
        </div>
      )}

      {loading && !data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-32 rounded-lg border border-gray-200 bg-gray-50 animate-pulse"
            />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.entities.map((e) => (
              <EntityCard key={e.key} entity={e} />
            ))}
          </div>

          {/* Reassurance copy about how data stays fresh */}
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-blue-50 border border-blue-100 p-3 text-sm text-blue-800">
            <ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p>
              Your data stays current automatically. New and updated records
              flow in through live webhooks, and a background sync runs around
              the clock to catch anything in between — no manual work needed.
            </p>
          </div>

          {/* Customer-requested re-sync */}
          {data.resync?.available && (
            <div className="mt-3 rounded-lg border border-gray-200 p-3">
              {data.resync.status === "queued" ||
              data.resync.status === "processing" ? (
                <div className="flex items-start gap-2 text-sm text-gray-700">
                  <Clock className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
                  <div>
                    <p className="font-medium text-gray-900">
                      Re-sync scheduled
                    </p>
                    <p className="text-gray-500">
                      We'll refresh your full history overnight so it won't slow
                      down your day.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-gray-600">
                    <p className="font-medium text-gray-900">
                      Think something's missing?
                    </p>
                    <p className="text-gray-500">
                      Ask us to re-pull your full history. We'll queue it for
                      overnight.
                      {data.resync.processedAt && (
                        <> Last re-sync {formatRelative(data.resync.processedAt)}.</>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={requestResync}
                    disabled={resyncing}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                  >
                    <RotateCw
                      className={`w-4 h-4 ${resyncing ? "animate-spin" : ""}`}
                    />
                    {resyncing ? "Scheduling…" : "Request a re-sync"}
                  </button>
                </div>
              )}
              {resyncMsg && (
                <p
                  className={`mt-2 text-sm ${
                    resyncMsg.kind === "error"
                      ? "text-red-600"
                      : "text-gray-600"
                  }`}
                >
                  {resyncMsg.text}
                </p>
              )}
            </div>
          )}

          <p className="mt-3 text-xs text-gray-400">
            Updated {formatRelative(data.generatedAt)}
          </p>
        </>
      )}
    </section>
  );
}
