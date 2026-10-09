"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Ban, KeyRound, Shield } from "lucide-react";

interface Connection {
  shopId: number;
  isActive: boolean;
  configured: true;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

const endpoint = "/api/platform-admin/appfueled-connections";
const inputClass =
  "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent outline-none disabled:opacity-50";
const secondaryClass =
  "px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50";

function parseShopId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function AppFueledConnections() {
  const [shopInput, setShopInput] = useState("");
  const [loadedShopId, setLoadedShopId] = useState<number | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mutationPending = useRef(false);
  const shopId = parseShopId(shopInput);
  const statusLoaded = shopId !== null && loadedShopId === shopId;

  useEffect(() => {
    return () => {
      requestVersion.current += 1;
      controller.current?.abort();
    };
  }, []);

  function clearCredentials() {
    setApiKey("");
    setApiSecret("");
    setConnectionId("");
  }

  function cancelEdit() {
    clearCredentials();
    setEditing(false);
    setError(null);
  }

  function changeShop(value: string) {
    requestVersion.current += 1;
    controller.current?.abort();
    setShopInput(value);
    setLoadedShopId(null);
    setConnection(null);
    setLoading(false);
    setEditing(false);
    setConfirmDisable(false);
    setError(null);
    setNotice(null);
    clearCredentials();
  }

  async function loadStatus(id: number, preserveNotice = false) {
    controller.current?.abort();
    const abortController = new AbortController();
    controller.current = abortController;
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setLoadedShopId(null);
    setConnection(null);
    setEditing(false);
    setConfirmDisable(false);
    clearCredentials();
    if (!preserveNotice) setNotice(null);
    try {
      const response = await fetch(`${endpoint}?shopId=${id}`, {
        credentials: "include",
        cache: "no-store",
        signal: abortController.signal,
      });
      const data = await response.json();
      if (!response.ok || data.success !== true) {
        throw new Error(
          typeof data.error === "string" ? data.error : "Unable to load AppFueled status.",
        );
      }
      if (
        data.connection !== null &&
        (!data.connection ||
          data.connection.shopId !== id ||
          data.connection.configured !== true ||
          typeof data.connection.isActive !== "boolean")
      ) {
        throw new Error("The server returned an unexpected connection status.");
      }
      if (version !== requestVersion.current) return;
      // Keep only the status metadata; credentials are never read into state.
      const status = data.connection;
      setConnection(status === null ? null : {
        shopId: status.shopId,
        isActive: status.isActive,
        configured: true,
        createdAt: status.createdAt,
        updatedAt: status.updatedAt,
        disabledAt: status.disabledAt ?? null,
      });
      setLoadedShopId(id);
    } catch (err) {
      if (version !== requestVersion.current || abortController.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Unable to load AppFueled status. Please retry.");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  async function saveConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!statusLoaded || !shopId || mutationPending.current) return;
    if (!apiKey.trim() || !apiSecret.trim() || !connectionId.trim()) {
      setError("All three credentials are required.");
      return;
    }
    await mutateConnection("PUT", shopId);
  }

  async function mutateConnection(method: "PUT" | "PATCH", id: number) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    const version = requestVersion.current;
    try {
      const response = await fetch(endpoint, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(method === "PUT"
          ? { shopId: id, apiKey, apiSecret, connectionId }
          : { shopId: id, isActive: false }),
      });
      // Never surface a write-response payload: it could echo submitted secrets.
      if (!response.ok) {
        throw new Error(method === "PUT"
          ? "Unable to save credentials. Check the values and shop ID, then retry."
          : "Unable to disable this connection. Please retry.");
      }
      if (version !== requestVersion.current) return;
      clearCredentials();
      setEditing(false);
      setConfirmDisable(false);
      setNotice(method === "PUT"
        ? `Credentials saved and AppFueled enabled for MOS shop ${id}.`
        : `AppFueled disabled for MOS shop ${id}.`);
      await loadStatus(id, true);
    } catch (err) {
      if (version === requestVersion.current) {
        setError(err instanceof Error ? err.message : "Request failed. Please retry.");
      }
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="appfueled-heading" className="mt-8 bg-white border border-gray-200 rounded-lg">
      <div className="p-5 border-b border-gray-200">
        <h2 id="appfueled-heading" className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          <KeyRound className="w-5 h-5 text-[#3c81c3]" aria-hidden="true" />
          AppFueled store credentials
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Manage AppFueled credentials for an existing MOS shop. These are separate from global partner API keys.
        </p>
      </div>
      <div className="p-5 space-y-4">
        <form
          className="flex flex-col sm:flex-row sm:items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (shopId && !saving && !loading) void loadStatus(shopId);
          }}
        >
          <div className="w-full sm:max-w-xs">
            <label htmlFor="appfueled-shop" className="block text-sm font-medium text-gray-700 mb-1">
              MOS shop ID
            </label>
            <input
              id="appfueled-shop"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={shopInput}
              onChange={(event) => changeShop(event.target.value)}
              disabled={saving}
              required
              aria-describedby="appfueled-shop-help"
              aria-invalid={Boolean(shopInput && !shopId)}
              className={inputClass}
              placeholder="Enter an existing MOS shop ID"
            />
          </div>
          <button type="submit" disabled={!shopId || saving || loading} className={secondaryClass}>
            {loading ? "Loading status…" : statusLoaded ? "Reload status" : "Load status"}
          </button>
        </form>
        <p id="appfueled-shop-help" className="text-xs text-gray-500">
          Use a positive whole-number MOS shop ID, not an AppFueled ID. This does not enroll or map shops.
          {shopInput && !shopId && <span className="block mt-1 text-red-700">Enter a valid positive shop ID.</span>}
        </p>

        {error && (
          <div role="alert" className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        {notice && <p role="status" className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">{notice}</p>}
        {loading && (
          <div role="status" aria-label="Loading connection status" className="space-y-2 p-4 bg-gray-50 rounded-lg animate-pulse">
            <div className="h-4 w-36 bg-gray-200 rounded" />
            <div className="h-3 w-2/3 bg-gray-200 rounded" />
          </div>
        )}
        {!loading && !statusLoaded && (
          <p className="p-4 bg-gray-50 rounded-lg text-sm text-gray-500">
            Load a shop&apos;s status before configuring its credentials.
          </p>
        )}
        {statusLoaded && !loading && (
          <div className="space-y-4">
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-gray-900">MOS shop {loadedShopId}</h3>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  !connection ? "bg-gray-100 text-gray-600" : connection.isActive ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                }`}>
                  {connection && (connection.isActive ? <Shield className="w-3 h-3" /> : <Ban className="w-3 h-3" />)}
                  {!connection ? "Not configured" : connection.isActive ? "Active" : "Disabled"}
                </span>
              </div>
              {connection ? (
                <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                  <div><dt className="text-gray-500">Created</dt><dd className="mt-0.5 text-gray-700">{formatDate(connection.createdAt)}</dd></div>
                  <div><dt className="text-gray-500">Updated</dt><dd className="mt-0.5 text-gray-700">{formatDate(connection.updatedAt)}</dd></div>
                  {!connection.isActive && <div><dt className="text-gray-500">Disabled</dt><dd className="mt-0.5 text-gray-700">{formatDate(connection.disabledAt)}</dd></div>}
                </dl>
              ) : <p className="mt-2 text-sm text-gray-500">No AppFueled credentials are configured for this shop.</p>}
            </div>
            {!editing && !confirmDisable && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => { clearCredentials(); setError(null); setNotice(null); setEditing(true); }}
                  className="px-4 py-2 text-sm font-medium text-white bg-[#3c81c3] rounded-lg hover:bg-[#3270ab] disabled:opacity-50"
                >
                  {!connection ? "Configure credentials" : connection.isActive ? "Replace credentials" : "Replace credentials & enable"}
                </button>
                {connection?.isActive && (
                  <button type="button" disabled={saving} onClick={() => { clearCredentials(); setError(null); setNotice(null); setConfirmDisable(true); }}
                    className="px-3 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50">
                    Disable connection
                  </button>
                )}
              </div>
            )}
            {editing && (
              <form onSubmit={saveConnection} autoComplete="off" className="space-y-4 border-t border-gray-200 pt-4">
                <p className="text-sm text-gray-600">
                  {connection ? "Replace all three credentials. Saving enables this connection." : "Enter all three credentials to configure and enable AppFueled."}
                  {" "}Saved credentials cannot be viewed or retrieved here.
                </p>
                <fieldset disabled={saving} className="space-y-4">
                  {([
                    ["api-key", "API key", apiKey, setApiKey],
                    ["api-secret", "API secret", apiSecret, setApiSecret],
                    ["connection-id", "Connection ID", connectionId, setConnectionId],
                  ] as const).map(([id, label, value, setter]) => (
                    <div key={id}>
                      <label htmlFor={`appfueled-${id}`} className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
                      <input id={`appfueled-${id}`} type="password" autoComplete="new-password" spellCheck={false}
                        autoCapitalize="none" value={value} onChange={(event) => setter(event.target.value)}
                        required className={inputClass} />
                    </div>
                  ))}
                  <p className="text-xs text-gray-500">All three fields are write-only and cleared after saving, cancellation, or a shop change.</p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={cancelEdit} className={secondaryClass}>Cancel</button>
                    <button type="submit" disabled={!apiKey.trim() || !apiSecret.trim() || !connectionId.trim()}
                      className="px-4 py-2 text-sm font-medium text-white bg-[#3c81c3] rounded-lg hover:bg-[#3270ab] disabled:opacity-50">
                      {saving ? "Saving…" : "Save credentials & enable"}
                    </button>
                  </div>
                </fieldset>
              </form>
            )}
            {confirmDisable && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm font-medium text-red-800">Disable AppFueled for MOS shop {loadedShopId}?</p>
                <p className="mt-1 text-sm text-red-700">To enable it again, you must replace all three credentials.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" disabled={saving} onClick={() => { setConfirmDisable(false); clearCredentials(); setError(null); }} className={secondaryClass}>Cancel</button>
                  <button type="button" disabled={saving} onClick={() => { if (shopId) void mutateConnection("PATCH", shopId); }}
                    className="px-3 py-2 text-sm font-medium text-white bg-red-700 rounded-lg hover:bg-red-800 disabled:opacity-50">
                    {saving ? "Disabling…" : "Confirm disable"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
