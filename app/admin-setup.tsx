"use client";

import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center">
              <h1 className="text-2xl font-bold text-gray-900">MOS Maintenance</h1>
            </div>
            <div className="flex items-center space-x-4">
              <Link href="/login" className="px-4 py-2 text-gray-600 hover:text-gray-900">
                Sign In
              </Link>
              <Link href="/setup" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">
                Get Started
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center">
          <h1 className="text-4xl tracking-tight font-extrabold text-gray-900 sm:text-5xl md:text-6xl">
            <span className="block">Vehicle Maintenance</span>
            <span className="block text-blue-600">Made Simple</span>
          </h1>
          <p className="mt-3 max-w-md mx-auto text-base text-gray-500 sm:text-lg md:mt-5 md:text-xl md:max-w-3xl">
            Professional vehicle maintenance tracking and recommendations for automotive shops and fleet managers.
          </p>
          <div className="mt-5 max-w-md mx-auto sm:flex sm:justify-center md:mt-8">
            <div className="rounded-md shadow">
              <Link href="/setup" className="w-full flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 md:py-4 md:text-lg md:px-10">
                Start Free Trial
              </Link>
            </div>
            <div className="mt-3 rounded-md shadow sm:mt-0 sm:ml-3">
              <Link href="/login" className="w-full flex items-center justify-center px-8 py-3 border border-gray-300 text-base font-medium rounded-md text-blue-600 bg-white hover:bg-gray-50 md:py-4 md:text-lg md:px-10">
                Sign In
              </Link>
            </div>
          </div>
        </div>

        {/* Features Section */}
        <div className="mt-20">
          <div className="text-center">
            <h2 className="text-3xl font-extrabold text-gray-900">
              Everything you need to manage vehicle maintenance
            </h2>
            <p className="mt-4 max-w-2xl mx-auto text-xl text-gray-500">
              Streamline your automotive business with our comprehensive maintenance management platform.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <div className="bg-white p-6 rounded-lg shadow">
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                🚗 Vehicle Tracking
              </h3>
              <p className="text-gray-500">
                Complete vehicle history and maintenance records. Track mileage, service intervals, and upcoming maintenance needs.
              </p>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                🔧 Smart Recommendations
              </h3>
              <p className="text-gray-500">
                AI-powered maintenance recommendations based on vehicle age, mileage, and manufacturer specifications.
              </p>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                👥 Customer Management
              </h3>
              <p className="text-gray-500">
                Manage customer information, vehicle ownership, and service history all in one centralized platform.
              </p>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                📊 Analytics Dashboard
              </h3>
              <p className="text-gray-500">
                Real-time insights into your business performance, revenue tracking, and customer retention metrics.
              </p>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                🔗 API Integration
              </h3>
              <p className="text-gray-500">
                Seamless integration with existing shop management systems, AutoFlow, Carfax, and other industry tools.
              </p>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                📱 Mobile Ready
              </h3>
              <p className="text-gray-500">
                Access your data anywhere with our responsive design that works perfectly on desktop, tablet, and mobile.
              </p>
            </div>
          </div>
        </div>

        {/* CTA Section */}
        <div className="mt-20 bg-blue-600 rounded-lg shadow-xl overflow-hidden">
          <div className="px-6 py-12 sm:px-12 sm:py-16 lg:flex lg:items-center lg:justify-between">
            <div>
              <h2 className="text-3xl font-extrabold tracking-tight text-white">
                Ready to streamline your maintenance operations?
              </h2>
              <p className="mt-3 text-lg text-blue-200">
                Join hundreds of automotive professionals who trust MOS Maintenance for their business.
              </p>
            </div>
            <div className="mt-8 lg:mt-0 lg:flex-shrink-0">
              <div className="inline-flex rounded-md shadow">
                <Link href="/setup" className="inline-flex items-center justify-center px-5 py-3 border border-transparent text-base font-medium rounded-md text-blue-600 bg-white hover:bg-gray-50">
                  Get Started Today
                </Link>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 mt-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex justify-between items-center">
            <p className="text-gray-500 text-sm">
              © 2025 MOS Maintenance MVP. All rights reserved.
            </p>
            <div className="flex space-x-6">
              <Link href="/login" className="text-gray-500 hover:text-gray-900 text-sm">
                Sign In
              </Link>
              <Link href="/setup" className="text-gray-500 hover:text-gray-900 text-sm">
                Get Started
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
      setWebhookToken(wt);
      logLine(`✅ Shop created: ${sid}`);
    } catch (e: any) {
      logLine(`❌ Create Shop failed: ${e.message || e}`);
    }
  }

  // Save AutoFlow credentials
  async function saveCreds() {
    try {
      if (!shopId) throw new Error("Create or enter a Shop ID first");
      const body: Record<string, string> = { apiKey, apiPassword };
      if (apiBase) body.apiBase = apiBase;

      const res = await fetch(`/api/shops/${shopId}/credentials`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      logLine(`✅ Credentials saved for shop ${shopId}`);
    } catch (e: any) {
      logLine(`❌ Save Creds failed: ${e.message || e}`);
    }
  }

  // Test webhook (sends a fake event directly to your endpoint)
  async function testWebhook() {
    try {
      const token = webhookToken || prompt("Enter webhook token") || "";
      if (!token) throw new Error("Webhook token required");
      const res = await fetch(`/api/webhooks/autoflow/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "test.event", data: { message: "hello" } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      logLine(`✅ Webhook OK: ${JSON.stringify(data)}`);
    } catch (e: any) {
      logLine(`❌ Webhook failed: ${e.message || e}`);
    }
  }

  // Admin: create DB indexes
  async function createIndexes() {
    try {
      if (!adminToken) throw new Error("Admin token required");
      const res = await fetch("/api/admin/db-indexes", {
        method: "POST",
        headers: { "X-Admin-Token": adminToken },
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(txt);
      logLine(`✅ DB Indexes: ${txt}`);
    } catch (e: any) {
      logLine(`❌ DB Indexes failed: ${e.message || e}`);
    }
  }

  // ===== Recent AutoFlow Events (no-cache fetch) =====
  const [events, setEvents] = useState<AutoflowLog[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [limit, setLimit] = useState(25);

  const lastFetch = useRef<number>(0);

  const recentEndpoint = useMemo(() => {
    // Add a ts bust param to avoid any intermediary caches
    const ts = Date.now();
    return `/api/events/autoflow/recent?limit=${limit}&ts=${ts}`;
  }, [limit]);

  async function loadRecent(logSuccess = false) {
    try {
      setEventsLoading(true);
      lastFetch.current = Date.now();
      const res = await fetch(recentEndpoint, {
        // In-browser fetch: ask for no store; server route also sends Cache-Control: no-store
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || JSON.stringify(data));
      setEvents(Array.isArray(data?.logs) ? data.logs : []);
      if (logSuccess) logLine("✅ Fetched recent AutoFlow events");
    } catch (e: any) {
      logLine(`❌ Fetch recent events failed: ${e.message || e}`);
    } finally {
      setEventsLoading(false);
    }
  }

  useEffect(() => {
    // initial fetch
    loadRecent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentEndpoint]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => loadRecent(false), 7000);
    return () => clearInterval(id);
  }, [autoRefresh, recentEndpoint]);

  const fmt = (d?: string) =>
    d ? new Date(d).toLocaleString() : "";

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-8">
      <h1 className="text-2xl font-bold">MOS Maintenance MVP</h1>

      {/* Create Shop */}
      <section className="rounded-2xl border p-5 space-y-3">
        <h2 className="text-lg font-semibold">1) Create Shop</h2>
        <div className="flex gap-2">
          <input
            className="flex-1 border rounded p-2"
            placeholder="Shop Name"
            value={shopName}
            onChange={(e) => setShopName(e.target.value)}
          />
          <button className="rounded bg-black text-white px-4 py-2" onClick={createShop}>
            Create
          </button>
        </div>

        <div className="text-sm text-gray-700 space-y-1">
          <div>
            Shop ID: <code>{shopId}</code>
          </div>
          <div>
            Webhook Token: <code>{webhookToken}</code>
          </div>

          {/* Copyable Webhook URL for AutoFlow */}
          {webhookToken && (
            <div className="mt-2">
              <div className="font-medium">Webhook URL for AutoFlow:</div>
              <div className="flex gap-2 items-center">
                <input className="w-full border rounded p-2" value={webhookUrl} readOnly />
                <button
                  className="rounded bg-black text-white px-3 py-2"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(webhookUrl);
                      logLine("✅ Copied webhook URL");
                    } catch {
                      logLine("❌ Copy failed");
                    }
                  }}
                >
                  Copy
                </button>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Paste this into AutoFlow’s Webhook/Callback URL for this shop.
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Credentials */}
      <section className="rounded-2xl border p-5 space-y-3">
        <h2 className="text-lg font-semibold">2) Save AutoFlow Credentials</h2>
        <input
          className="w-full border rounded p-2"
          placeholder="Shop ID (or use above)"
          value={shopId}
          onChange={(e) => setShopId(e.target.value)}
        />
        <div className="flex flex-col gap-2">
          <input
            className="border rounded p-2"
            placeholder="API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <input
            className="border rounded p-2"
            placeholder="API Password"
            value={apiPassword}
            onChange={(e) => setApiPassword(e.target.value)}
          />
          <input
            className="border rounded p-2"
            placeholder="API Base (optional, e.g. https://api.autoflow.com)"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
          />
          <button className="self-start rounded bg-black text-white px-4 py-2" onClick={saveCreds}>
            Save
          </button>
        </div>
      </section>

      {/* Webhook */}
      <section className="rounded-2xl border p-5 space-y-3">
        <h2 className="text-lg font-semibold">3) Test Webhook</h2>
        <button className="rounded bg-black text-white px-4 py-2" onClick={testWebhook}>
          Send Test Event
        </button>
      </section>

      {/* Recent Events (no-cache) */}
      <section className="rounded-2xl border p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">4) Recent AutoFlow Events</h2>
          <div className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-1">
              <span className="text-gray-600">Limit</span>
              <select
                className="border rounded px-2 py-1"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 25)}
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              <span className="text-gray-600">Auto refresh</span>
            </label>
            <button
              className="rounded bg-black text-white px-3 py-1.5"
              onClick={() => loadRecent(true)}
              disabled={eventsLoading}
              title="Fetches with cache: 'no-store' and a ts param"
            >
              {eventsLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="text-xs text-gray-500">
          Last fetch: {lastFetch.current ? new Date(lastFetch.current).toLocaleTimeString() : "—"}
        </div>

        {events.length === 0 ? (
          <div className="text-sm text-gray-600">No events found yet.</div>
        ) : (
          <div className="space-y-3">
            {events.map((e, i) => {
              const t = e?.payload?.text as string | undefined;
              const eventType = e?.payload?.event?.type as string | undefined;
              const cust =
                e?.payload?.customer
                  ? `${e.payload.customer.firstname ?? ""} ${e.payload.customer.lastname ?? ""}`.trim()
                  : "";
              const veh = e?.payload?.vehicle
                ? `${e.payload.vehicle.year ?? ""} ${e.payload.vehicle.make ?? ""} ${e.payload.vehicle.model ?? ""}`.trim()
                : "";
              return (
                <div key={i} className="rounded-xl border p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="font-medium">
                        {t || eventType || "(event)"}{" "}
                        <span className="text-gray-500 font-normal">· token {e.token}</span>
                      </div>
                      <div className="text-gray-600">
                        {cust && <span>{cust}</span>}
                        {cust && veh && <span> · </span>}
                        {veh && <span>{veh}</span>}
                      </div>
                    </div>
                    <div className="text-xs text-gray-500">{fmt(e.receivedAt)}</div>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Show JSON</summary>
                    <pre className="mt-1 max-h-64 overflow-auto bg-gray-50 p-2 rounded text-xs">
                      {JSON.stringify(e.payload ?? e, null, 2)}
                    </pre>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Admin */}
      <section className="rounded-2xl border p-5 space-y-3">
        <h2 className="text-lg font-semibold">Admin (optional)</h2>
        <div className="flex gap-2">
          <input
            className="flex-1 border rounded p-2"
            placeholder="X-Admin-Token"
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
          />
          <button className="rounded bg-black text-white px-4 py-2" onClick={createIndexes}>
            Create DB Indexes
          </button>
        </div>
      </section>

      {/* Log */}
      <section className="rounded-2xl border p-5 space-y-2">
        <h2 className="text-lg font-semibold">Log</h2>
        <pre className="text-xs bg-gray-50 p-3 rounded max-h-64 overflow-auto whitespace-pre-wrap">
{log}
        </pre>
      </section>
    </main>
  );
}


