// app/dashboard/events/page.tsx
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

type EventDoc = {
  _id: any;
  receivedAt?: Date;
  provider?: string;
  payload?: any;
  raw?: string | null;
};

type EventRow = {
  id: string;
  ts: string | Date;
  provider: string;
  event: string;   // always a string for rendering
  preview: string;
  payload: any;
};

function pick<T = any>(obj: any, keys: string[]): T | undefined {
  for (const k of keys) {
    const path = k.split(".");
    let cur = obj;
    for (const part of path) {
      if (cur && typeof cur === "object" && part in cur) cur = cur[part];
      else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null && cur !== "") return cur as T;
  }
  return undefined;
}

function toLabel(val: any): string {
  if (val == null) return "unknown";
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  // common shapes: { type, id, timestamp } etc.
  if (typeof val === "object") {
    const type = (val as any).type ?? (val as any).name ?? (val as any).event;
    if (type) return String(type);
    try {
      return JSON.stringify(val);
    } catch {
      return "[object]";
    }
  }
  return String(val);
}

function buildPreview(payload: any): string {
  if (!payload) return "(no payload)";
  const first = pick<string>(payload, ["customer.first", "customer.firstname", "first", "first_name"]);
  const last  = pick<string>(payload, ["customer.last", "customer.lastname", "last", "last_name"]);
  const name  = [first, last].filter(Boolean).join(" ").trim();

  const vin   = pick<string>(payload, ["vehicle.vin", "vin"]);
  const ro    = pick<string | number>(payload, ["ro_number", "roNumber", "ro", "roNo"]);
  const miles = pick<number | string>(payload, ["mileage", "miles", "odometer", "odo"]);

  const bits: string[] = [];
  if (name) bits.push(name);
  if (vin) bits.push(`VIN ${vin}`);
  if (ro !== undefined) bits.push(`RO ${ro}`);
  if (miles !== undefined) bits.push(`${miles} mi`);
  return bits.length ? bits.join(" · ") : "(no quick summary)";
}

export default async function EventsPage() {
  const sess = await requireSession();

const db = await getDb();

// Configurable limit:
// - DEFAULT_EVENTS_LIMIT=0  → no limit (show all)
// - DEFAULT_EVENTS_LIMIT>0  → use that number (clamped to 500)
const raw = Number(process.env.DEFAULT_EVENTS_LIMIT ?? '0');
const limit = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 500) : 0;

const cursor = db
  .collection("events")
  .find({ provider: "autoflow", shopId: sess.shopId })
  .sort({ receivedAt: -1 });

if (limit > 0) {
  cursor.limit(limit);
}

const docs = (await cursor.toArray()) as EventDoc[];

  const items: EventRow[] = docs.map((d) => {
    let payload = d.payload;
    if (!payload && d.raw) {
      try { payload = JSON.parse(d.raw); } catch { payload = null; }
    }
    const eventRaw =
      pick<any>(payload, ["event", "type", "name"]) ?? "unknown";
    return {
      id: String(d._id),
      ts: d.receivedAt ?? new Date(),
      provider: d.provider ?? "autoflow",
      event: toLabel(eventRaw),              // <-- ensure string
      preview: buildPreview(payload),
      payload,
    };
  });

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Webhook Console</h1>
        <a
          href="/api/events/list?limit=50"
          className="rounded bg-black text-white px-3 py-1.5 text-sm"
        >
          View as JSON
        </a>
      </div>

      <div className="rounded-2xl border divide-y">
        <div className="grid grid-cols-4 gap-2 text-xs font-semibold p-3 bg-gray-50">
          <div>Time</div>
          <div>Provider</div>
          <div>Event</div>
          <div>Preview</div>
        </div>

        {items.map((e) => {
          const when = new Date(e.ts).toLocaleString();
          return (
            <div key={e.id} className="p-3">
              <div className="grid grid-cols-4 gap-2 text-sm">
                <div className="truncate">{when}</div>
                <div className="truncate">{e.provider}</div>
                <div className="truncate">{e.event}</div> {/* now always string */}
                <div className="truncate">{e.preview}</div>
              </div>

              <details className="mt-2">
                <summary className="text-xs underline cursor-pointer">Show JSON</summary>
                <pre className="mt-2 text-xs bg-gray-50 p-3 rounded overflow-auto max-h-64">
{JSON.stringify(e.payload, null, 2)}
                </pre>
              </details>
            </div>
          );
        })}

        {items.length === 0 && (
          <div className="p-6 text-sm text-neutral-600">No events yet.</div>
        )}
      </div>

      <p className="text-xs text-gray-500">
        Shows the most recent AutoFlow events for your shop.
      </p>
    </main>
  );
}
