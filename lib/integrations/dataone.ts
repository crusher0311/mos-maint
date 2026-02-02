// lib/integrations/dataone.ts
import "server-only";
import { getDb } from "@/lib/mongo";

type Fetcher = typeof fetch;

/** -------- Types exposed to the UI -------- */
export type OeServiceItem = {
  id?: string | null;                 // provider id/code for the service
  title?: string | null;              // short name (e.g., "Engine Oil and Filter")
  description?: string | null;        // longer description/details
  intervalMiles?: number | null;      // suggested interval miles (if any)
  intervalMonths?: number | null;     // suggested interval months (if any)
  dueAtMiles?: number | null;         // next due miles (if present)
  dueAtDate?: string | null;          // next due date (ISO)
  severity?: "due" | "overdue" | "upcoming" | null; // simple computed label
};

export type OeScheduleResult = {
  ok: boolean;
  vin?: string | null;
  mileageUsed?: number | null;        // mileage we used to compute “due”
  items?: OeServiceItem[] | null;
  raw?: any;
  error?: string;
};

/** -------- Config (env) --------
 * Keep this global for all shops. Add your values to .env.local:
 *   DATAONE_BASE_URL="https://…"
 *   DATAONE_API_KEY="…"
 *   DATAONE_ACCOUNT_ID="…"       (optional if your account needs it)
 */
export function resolveDataOneConfig() {
  const base = (process.env.DATAONE_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.DATAONE_API_KEY || "";
  const accountId = process.env.DATAONE_ACCOUNT_ID || ""; // optional

  return {
    base,
    apiKey,
    accountId,
    configured: Boolean(base) && Boolean(apiKey),
  };
}

/** -------- Helpers -------- */
function toInt(val: any): number | null {
  if (val == null) return null;
  const n = Number(String(val).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function nonEmpty(s: any): string | null {
  const t = s == null ? "" : String(s).trim();
  return t ? t : null;
}

/** -------- Normalization --------
 * DataOne variants differ by plan. We try to normalize common shapes:
 *  - result.services / result.maintenance / schedules[].operations[]
 */
function normalizeOeItems(json: any): OeServiceItem[] {
  const out: OeServiceItem[] = [];

  const candidates: any[] = [];
  if (Array.isArray(json?.services)) candidates.push(...json.services);
  if (Array.isArray(json?.maintenance)) candidates.push(...json.maintenance);
  if (Array.isArray(json?.schedules)) {
    for (const sch of json.schedules) {
      if (Array.isArray(sch?.operations)) candidates.push(...sch.operations);
    }
  }

  for (const s of candidates) {
    // Try several common field names
    const id =
      nonEmpty(s?.id) ||
      nonEmpty(s?.code) ||
      nonEmpty(s?.serviceId) ||
      null;

    const title =
      nonEmpty(s?.title) ||
      nonEmpty(s?.name) ||
      nonEmpty(s?.operation) ||
      null;

    const description =
      nonEmpty(s?.description) ||
      nonEmpty(s?.details) ||
      nonEmpty(s?.notes) ||
      null;

    const intervalMiles =
      toInt(s?.intervalMiles) ??
      toInt(s?.mileageInterval) ??
      toInt(s?.interval?.miles) ??
      null;

    const intervalMonths =
      toInt(s?.intervalMonths) ??
      toInt(s?.monthsInterval) ??
      toInt(s?.interval?.months) ??
      null;

    const dueAtMiles =
      toInt(s?.dueAtMiles) ??
      toInt(s?.nextDueMileage) ??
      toInt(s?.next?.miles) ??
      null;

    const dueAtDate =
      nonEmpty(s?.dueAtDate) ||
      nonEmpty(s?.nextDueDate) ||
      nonEmpty(s?.next?.date) ||
      null;

    // Compute a simple severity if the provider gives “status”
    let severity: OeServiceItem["severity"] = null;
    const stat = String(s?.status ?? "").toLowerCase();
    if (stat.includes("overdue")) severity = "overdue";
    else if (stat.includes("due")) severity = "due";
    else if (stat.includes("upcoming") || stat.includes("future")) severity = "upcoming";

    out.push({
      id,
      title,
      description,
      intervalMiles,
      intervalMonths,
      dueAtMiles,
      dueAtDate,
      severity,
    });
  }

  return out;
}

/** -------- Live fetch (by VIN + optional mileage) --------
 * Because DataOne flavors vary, configure a flexible GET with query params:
 *   GET {base}/oe-services?vin=…&mileage=…
 * If your tenant requires a different path or POST body, just tweak here.
 */
export async function fetchDataOneOeByVin(
  vin: string,
  mileageForCalc?: number | null,
  doFetch: Fetcher = fetch
): Promise<OeScheduleResult> {
  const cfg = resolveDataOneConfig();
  if (!cfg.configured) return { ok: false, error: "DATAONE not configured (env)." };
  if (!vin) return { ok: false, error: "VIN is required." };

  // Build a generic URL; adjust this to your actual endpoint if needed.
  const url = new URL(`${cfg.base}/oe-services`);
  url.searchParams.set("vin", vin);
  if (typeof mileageForCalc === "number") {
    url.searchParams.set("mileage", String(mileageForCalc));
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    "x-api-key": cfg.apiKey,
  };
  if (cfg.accountId) headers["x-account-id"] = cfg.accountId;

  const res = await doFetch(url.toString(), {
    method: "GET",
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
  }

  const json = await res.json().catch(() => null);
  if (!json || typeof json !== "object") {
    return { ok: false, error: "Invalid JSON from DATAONE." };
  }

  const items = normalizeOeItems(json);
  return {
    ok: true,
    vin,
    mileageUsed: typeof mileageForCalc === "number" ? mileageForCalc : null,
    items,
    raw: json,
  };
}

/** -------- Snapshot storage (cache) -------- */
export async function upsertDataOneSnapshot(
  shopId: number,
  vin: string,
  mileageForCalc: number | null,
  payload: OeScheduleResult
) {
  const db = await getDb();
  const now = new Date();
  await db.collection("dataone_oe").updateOne(
    { shopId, vin },
    {
      $set: {
        shopId,
        vin,
        fetchedAt: now,
        mileageUsed: mileageForCalc ?? null,
        items: payload.items ?? null,
        ok: payload.ok,
        error: payload.error ?? null,
        raw: payload.raw ?? null,
        source: "dataone",
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

function snapshotToResult(doc: any): OeScheduleResult {
  if (!doc) return { ok: false, error: "No snapshot" };
  return {
    ok: !!doc.ok,
    vin: doc.vin ?? null,
    mileageUsed: doc.mileageUsed ?? null,
    items: doc.items ?? null,
    raw: doc.raw ?? null,
    error: doc.error ?? null,
  };
}

/** Cached fetch (defaults to 7 days) */
export async function fetchDataOneOeWithCache(
  shopId: number,
  vin: string,
  mileageForCalc: number | null,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  doFetch: Fetcher = fetch
): Promise<OeScheduleResult> {
  const db = await getDb();
  const key = { shopId, vin };
  const doc = await db.collection("dataone_oe").findOne(key);

  const now = Date.now();
  const fresh = doc?.fetchedAt ? now - new Date(doc.fetchedAt).getTime() <= maxAgeMs : false;

  if (fresh) return snapshotToResult(doc);

  const live = await fetchDataOneOeByVin(vin, mileageForCalc, doFetch);
  await upsertDataOneSnapshot(shopId, vin, mileageForCalc, live);
  return live;
}
