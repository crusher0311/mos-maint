import "server-only";
import sql from "@/lib/db/postgres";

type Fetcher = typeof fetch;

export type OeServiceItem = {
  id?: string | null;
  title?: string | null;
  description?: string | null;
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  dueAtMiles?: number | null;
  dueAtDate?: string | null;
  severity?: "due" | "overdue" | "upcoming" | null;
};

export type OeScheduleResult = {
  ok: boolean;
  vin?: string | null;
  mileageUsed?: number | null;
  items?: OeServiceItem[] | null;
  raw?: unknown;
  error?: string;
};

export function resolveDataOneConfig() {
  const base = (process.env.DATAONE_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.DATAONE_API_KEY || "";
  const accountId = process.env.DATAONE_ACCOUNT_ID || "";

  return {
    base,
    apiKey,
    accountId,
    configured: Boolean(base) && Boolean(apiKey),
  };
}

function toInt(val: unknown): number | null {
  if (val == null) return null;
  const n = Number(String(val).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function nonEmpty(s: unknown): string | null {
  const t = s == null ? "" : String(s).trim();
  return t ? t : null;
}

function normalizeOeItems(json: Record<string, unknown>): OeServiceItem[] {
  const out: OeServiceItem[] = [];
  const candidates: Record<string, unknown>[] = [];

  if (Array.isArray(json?.services)) candidates.push(...json.services);
  if (Array.isArray(json?.maintenance)) candidates.push(...json.maintenance);
  if (Array.isArray(json?.schedules)) {
    for (const sch of json.schedules as Record<string, unknown>[]) {
      if (Array.isArray(sch?.operations)) candidates.push(...sch.operations);
    }
  }

  for (const s of candidates) {
    const id = nonEmpty(s?.id) || nonEmpty(s?.code) || nonEmpty(s?.serviceId) || null;
    const title = nonEmpty(s?.title) || nonEmpty(s?.name) || nonEmpty(s?.operation) || null;
    const description = nonEmpty(s?.description) || nonEmpty(s?.details) || nonEmpty(s?.notes) || null;

    const interval = s?.interval as Record<string, unknown> | undefined;
    const intervalMiles = toInt(s?.intervalMiles) ?? toInt(s?.mileageInterval) ?? toInt(interval?.miles) ?? null;
    const intervalMonths = toInt(s?.intervalMonths) ?? toInt(s?.monthsInterval) ?? toInt(interval?.months) ?? null;

    const next = s?.next as Record<string, unknown> | undefined;
    const dueAtMiles = toInt(s?.dueAtMiles) ?? toInt(s?.nextDueMileage) ?? toInt(next?.miles) ?? null;
    const dueAtDate = nonEmpty(s?.dueAtDate) || nonEmpty(s?.nextDueDate) || nonEmpty(next?.date) || null;

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

export async function fetchDataOneOeByVin(
  vin: string,
  mileageForCalc?: number | null,
  doFetch: Fetcher = fetch
): Promise<OeScheduleResult> {
  const cfg = resolveDataOneConfig();
  if (!cfg.configured) return { ok: false, error: "DATAONE not configured (env)." };
  if (!vin) return { ok: false, error: "VIN is required." };

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

  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
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

export async function upsertDataOneSnapshot(
  shopId: number | string,
  vin: string,
  mileageForCalc: number | null,
  payload: OeScheduleResult
) {
  const shopIdStr = String(shopId);
  const vinUpper = vin.toUpperCase();

  await sql`
    INSERT INTO dataone_oe (shop_id, vin, fetched_at, mileage_used, items, ok, error, raw, source)
    VALUES (${shopIdStr}, ${vinUpper}, NOW(), ${mileageForCalc}, ${JSON.stringify(payload.items || null)}::jsonb,
      ${payload.ok}, ${payload.error || null}, ${JSON.stringify(payload.raw || null)}::jsonb, 'dataone')
    ON CONFLICT (shop_id, vin) DO UPDATE SET
      fetched_at = NOW(),
      mileage_used = ${mileageForCalc},
      items = ${JSON.stringify(payload.items || null)}::jsonb,
      ok = ${payload.ok},
      error = ${payload.error || null},
      raw = ${JSON.stringify(payload.raw || null)}::jsonb
  `;
}

function snapshotToResult(doc: Record<string, unknown>): OeScheduleResult {
  if (!doc) return { ok: false, error: "No snapshot" };
  return {
    ok: !!doc.ok,
    vin: doc.vin as string ?? null,
    mileageUsed: doc.mileage_used as number ?? null,
    items: doc.items as OeServiceItem[] ?? null,
    raw: doc.raw ?? null,
    error: doc.error as string ?? null,
  };
}

export async function fetchDataOneOeWithCache(
  shopId: number | string,
  vin: string,
  mileageForCalc: number | null,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  doFetch: Fetcher = fetch
): Promise<OeScheduleResult> {
  const shopIdStr = String(shopId);
  const vinUpper = vin.toUpperCase();

  const result = await sql`
    SELECT * FROM dataone_oe WHERE shop_id = ${shopIdStr} AND vin = ${vinUpper} LIMIT 1
  `;
  const doc = result[0];

  const now = Date.now();
  const fresh = doc?.fetched_at ? now - new Date(doc.fetched_at as string).getTime() <= maxAgeMs : false;

  if (fresh) return snapshotToResult(doc);

  const live = await fetchDataOneOeByVin(vin, mileageForCalc, doFetch);
  await upsertDataOneSnapshot(shopId, vin, mileageForCalc, live);
  return live;
}
