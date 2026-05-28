// Platform-admin view of Detect Dog extension telemetry events (task #511).
// Groups raw events from `extension_telemetry_events` by (shop, event, day)
// so on-call can spot regressions — e.g. an auth.token_invalid_cleared
// spike on one shop — without writing queries.
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 7;
const MAX_ROWS = 500;

type GroupedRow = {
  mosShopId: number | null;
  event: string;
  day: string;
  count: number;
  lastOccurredAt: Date;
  lastCode: string | null;
  shopName: string | null;
};

async function loadTelemetry(days: number): Promise<{
  rows: GroupedRow[];
  totalEvents: number;
  totalErrorEvents: number;
  uniqueShops: number;
  generatedAt: Date;
}> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const grouped = await db
    .collection("extension_telemetry_events")
    .aggregate([
      { $match: { occurredAt: { $gte: since } } },
      {
        $group: {
          _id: {
            mosShopId: "$mosShopId",
            event: "$event",
            day: {
              $dateToString: { format: "%Y-%m-%d", date: "$occurredAt" },
            },
          },
          count: { $sum: 1 },
          lastOccurredAt: { $max: "$occurredAt" },
          lastCode: { $last: "$payload.code" },
        },
      },
      { $sort: { lastOccurredAt: -1 } },
      { $limit: MAX_ROWS },
    ])
    .toArray();

  const shopIds = Array.from(
    new Set(
      grouped
        .map((g: any) => g._id.mosShopId)
        .filter((id: any) => id != null),
    ),
  );

  const shopDocs = shopIds.length
    ? await db
        .collection("shops")
        .find(
          {
            $or: [
              { shopId: { $in: shopIds.map(String) } },
              { shopId: { $in: shopIds.map((id: any) => Number(id)) } },
            ],
          },
          { projection: { shopId: 1, name: 1 } },
        )
        .toArray()
    : [];
  const shopNameById = new Map<string, string>();
  for (const s of shopDocs as any[]) {
    shopNameById.set(String(s.shopId), s.name || "");
  }

  const rows: GroupedRow[] = grouped.map((g: any) => ({
    mosShopId: g._id.mosShopId ?? null,
    event: g._id.event,
    day: g._id.day,
    count: g.count,
    lastOccurredAt: g.lastOccurredAt,
    lastCode: g.lastCode || null,
    shopName: g._id.mosShopId != null ? shopNameById.get(String(g._id.mosShopId)) || null : null,
  }));

  const totalEvents = rows.reduce((acc, r) => acc + r.count, 0);
  const totalErrorEvents = rows
    .filter((r) => r.event !== "auth.soft_expired")
    .reduce((acc, r) => acc + r.count, 0);
  const uniqueShops = new Set(rows.map((r) => r.mosShopId).filter((id) => id != null)).size;

  return {
    rows,
    totalEvents,
    totalErrorEvents,
    uniqueShops,
    generatedAt: new Date(),
  };
}

const EVENT_LABELS: Record<string, string> = {
  "auth.soft_expired": "Soft session expired (transient 401)",
  "auth.token_invalid_cleared": "Token cleared (forced logout)",
  "api.fetch_failure": "API fetch failed after retries",
  "action.dropped": "User action dropped",
};

const EVENT_COLORS: Record<string, string> = {
  "auth.soft_expired": "bg-amber-50 text-amber-800",
  "auth.token_invalid_cleared": "bg-red-50 text-red-800",
  "api.fetch_failure": "bg-orange-50 text-orange-800",
  "action.dropped": "bg-rose-50 text-rose-800",
};

export default async function ExtensionTelemetryPage({
  searchParams,
}: {
  searchParams?: { days?: string };
}) {
  const session = await requireSession();
  if (session.role !== "platform_admin") redirect("/admin");

  const daysParam = parseInt(searchParams?.days || "", 10);
  const days = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 30 ? daysParam : DEFAULT_DAYS;

  const { rows, totalEvents, totalErrorEvents, uniqueShops, generatedAt } = await loadTelemetry(days);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Extension Telemetry</h1>
          <p className="mt-1 text-sm text-gray-500">
            Client-side events from the Detect Dog Chrome extension (last {days}d). Auto-expires after 30d.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          {[1, 3, 7, 14, 30].map((d) => (
            <a
              key={d}
              href={`?days=${d}`}
              className={`px-3 py-1 rounded ${
                d === days ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {d}d
            </a>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase">Total events</div>
          <div className="text-2xl font-semibold mt-1">{totalEvents.toLocaleString()}</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase">Error events</div>
          <div className="text-2xl font-semibold mt-1">{totalErrorEvents.toLocaleString()}</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase">Distinct shops</div>
          <div className="text-2xl font-semibold mt-1">{uniqueShops.toLocaleString()}</div>
        </div>
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Day</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Shop</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Event</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Count</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Last code</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                  No telemetry events in this window.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-xs text-gray-700">{r.day}</td>
                <td className="px-3 py-2">
                  {r.mosShopId != null ? (
                    <span>
                      <span className="font-medium">{r.shopName || `Shop ${r.mosShopId}`}</span>
                      <span className="ml-1 text-xs text-gray-400">#{r.mosShopId}</span>
                    </span>
                  ) : (
                    <span className="text-gray-400 italic">unknown</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs ${
                      EVENT_COLORS[r.event] || "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {EVENT_LABELS[r.event] || r.event}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono">{r.count.toLocaleString()}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-600">{r.lastCode || "—"}</td>
                <td className="px-3 py-2 text-xs text-gray-500">
                  {new Date(r.lastOccurredAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-gray-400">
        Showing up to {MAX_ROWS} grouped rows. Generated {generatedAt.toLocaleString()}.
      </p>
    </div>
  );
}
