import "server-only";
import sql from "@/lib/db/postgres";
import { trackApiRequest } from "@/lib/api-usage-tracker";

type Fetcher = typeof fetch;

export type CarfaxServiceRecord = {
  date?: string | null;
  odometer?: number | null;
  description?: string | null;
  location?: string | null;
};

export type CarfaxResult = {
  ok: boolean;
  vin?: string | null;
  reportDate?: string | null;
  numberOfOwners?: number | null;
  accidents?: number | null;
  damageReports?: number | null;
  lastReportedMileage?: number | null;
  serviceRecords?: CarfaxServiceRecord[] | null;
  titleIssues?: string[] | null;
  recalls?: string[] | null;
  raw?: unknown;
  error?: string;
};

export async function resolveCarfaxConfig(shopId: number | string) {
  const shopIdStr = String(shopId);
  const result = await sql`
    SELECT carfax FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1
  `;

  const shop = result[0];
  const carfax = shop?.carfax as Record<string, unknown> | undefined;
  const locationId = carfax?.locationId ?? null;

  const base = (process.env.CARFAX_POST_URL || "").replace(/\/+$/, "");
  const productDataId = process.env.CARFAX_PDI || "";

  return {
    base,
    productDataId,
    locationId,
    hasEnv: Boolean(base) && Boolean(productDataId),
    hasLocation: Boolean(locationId),
    configured: Boolean(base) && Boolean(productDataId) && Boolean(locationId),
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

export async function fetchCarfaxLive(
  shopId: number | string,
  vin: string,
  doFetch: Fetcher = fetch
): Promise<CarfaxResult> {
  const cfg = await resolveCarfaxConfig(shopId);
  if (!cfg.hasEnv) return { ok: false, error: "CARFAX not configured: missing API base or Product Data ID (env)." };
  if (!cfg.hasLocation) return { ok: false, error: "CARFAX not configured: missing Location ID for this shop." };
  if (!vin) return { ok: false, error: "VIN is required." };

  const payload = { vin, productDataId: cfg.productDataId, locationId: cfg.locationId };
  const startTime = Date.now();

  const res = await doFetch(cfg.base, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const latencyMs = Date.now() - startTime;
  const shopIdNum = typeof shopId === "number" ? shopId : parseInt(shopId, 10);
  trackApiRequest('carfax', '/data', 'POST', res.status, latencyMs, shopIdNum).catch(() => {});

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
  }

  const json = await res.json().catch(() => null);
  if (!json || typeof json !== "object") {
    return { ok: false, error: "Invalid JSON from CARFAX." };
  }

  const root = (json as Record<string, unknown>)?.report || (json as Record<string, unknown>)?.data || json;
  const rootObj = root as Record<string, unknown>;

  const vinOut =
    nonEmpty(rootObj?.vin) ||
    nonEmpty((rootObj?.vehicle as Record<string, unknown>)?.vin) ||
    nonEmpty(rootObj?.inputVin) ||
    nonEmpty((rootObj?.serviceHistory as Record<string, unknown>)?.vin) ||
    vin;

  const reportDate =
    nonEmpty(rootObj?.reportDate) ||
    nonEmpty(rootObj?.generatedAt) ||
    nonEmpty(rootObj?.createdAt) ||
    null;

  const owners =
    toInt(rootObj?.numberOfOwners) ??
    toInt(rootObj?.ownersCount) ??
    (Array.isArray(rootObj?.ownershipHistory) ? rootObj.ownershipHistory.length : null);

  const accidents =
    toInt(rootObj?.accidentCount) ??
    (Array.isArray(rootObj?.accidents) ? (rootObj.accidents as unknown[]).length : null) ??
    null;

  const damageReports =
    toInt(rootObj?.damageCount) ??
    (Array.isArray(rootObj?.damage) ? (rootObj.damage as unknown[]).length : null) ??
    null;

  let serviceRecords: CarfaxServiceRecord[] | null = null;
  let lastMiles: number | null =
    toInt(rootObj?.lastReportedMileage) ??
    toInt(rootObj?.odometerLastReported) ??
    toInt((rootObj?.odometer as Record<string, unknown>)?.lastReported) ??
    null;

  const svcSrc =
    (Array.isArray(rootObj?.serviceHistory) && rootObj.serviceHistory) ||
    (Array.isArray(rootObj?.serviceRecords) && rootObj.serviceRecords) ||
    (Array.isArray(rootObj?.services) && rootObj.services) ||
    null;

  if (Array.isArray(svcSrc)) {
    serviceRecords = svcSrc.map((s: Record<string, unknown>) => ({
      date: nonEmpty(s?.date) || nonEmpty(s?.serviceDate) || nonEmpty(s?.reportedDate),
      odometer: toInt(s?.odometer) ?? toInt(s?.mileage),
      description: nonEmpty(s?.description) || nonEmpty(s?.details),
      location: nonEmpty(s?.location) || nonEmpty(s?.dealer) || nonEmpty(s?.source),
    }));
    if (lastMiles == null) {
      const maxFromList = Math.max(
        ...serviceRecords
          .map((r) => (r.odometer ?? -1))
          .filter((n) => typeof n === "number" && n >= 0),
        -1
      );
      lastMiles = maxFromList >= 0 ? maxFromList : null;
    }
  }

  const disp = (rootObj?.serviceHistory as Record<string, unknown>)?.displayRecords;
  if (Array.isArray(disp)) {
    const mapped: CarfaxServiceRecord[] = disp
      .filter((r: Record<string, unknown>) => String(r?.type || "").toLowerCase() === "service")
      .map((r: Record<string, unknown>) => ({
        date: nonEmpty(r?.displayDate),
        odometer: toInt(r?.odometer),
        description: Array.isArray(r?.text) ? (r.text as string[]).map((t) => String(t)).join("; ") : nonEmpty(r?.text),
        location: null,
      }));

    serviceRecords = Array.isArray(serviceRecords) ? [...serviceRecords, ...mapped] : mapped;

    if (lastMiles == null) {
      const maxFromDisplay = Math.max(
        ...disp
          .map((r: Record<string, unknown>) => toInt(r?.odometer) ?? -1)
          .filter((n: number) => n >= 0),
        -1
      );
      lastMiles = maxFromDisplay >= 0 ? maxFromDisplay : null;
    }
  }

  const titleIssues: string[] | null =
    Array.isArray(rootObj?.titleIssues)
      ? (rootObj.titleIssues as unknown[]).map((x) => String(x)).filter(Boolean)
      : null;

  const recalls: string[] | null =
    Array.isArray(rootObj?.recalls)
      ? (rootObj.recalls as Record<string, unknown>[]).map((r) => nonEmpty(r?.title || r?.name)).filter(Boolean) as string[]
      : null;

  return {
    ok: true,
    vin: vinOut ?? vin,
    reportDate,
    numberOfOwners: owners ?? null,
    accidents: accidents ?? null,
    damageReports: damageReports ?? null,
    lastReportedMileage: lastMiles ?? null,
    serviceRecords: serviceRecords ?? null,
    titleIssues: titleIssues ?? null,
    recalls: recalls ?? null,
    raw: json,
  };
}

export async function upsertCarfaxSnapshot(
  shopId: number | string,
  vin: string,
  report: CarfaxResult
) {
  const shopIdStr = String(shopId);
  const vinUpper = vin.toUpperCase();

  // Get shop UUID from text shop_id
  const shopResult = await sql`SELECT id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1`;
  const shopUuid = shopResult[0]?.id;
  
  if (!shopUuid) {
    console.error(`[CARFAX] Cannot upsert snapshot: shop ${shopIdStr} not found`);
    return;
  }

  // Store all report data in the report_data jsonb column
  const reportData = {
    ok: report.ok,
    reportDate: report.reportDate,
    numberOfOwners: report.numberOfOwners,
    accidents: report.accidents,
    damageReports: report.damageReports,
    lastReportedMileage: report.lastReportedMileage,
    serviceRecords: report.serviceRecords,
    titleIssues: report.titleIssues,
    recalls: report.recalls,
    error: report.error,
    raw: report.raw
  };

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
  const jsonData = JSON.stringify(reportData);

  await sql`
    INSERT INTO carfax_reports (shop_id, vin, report_type, report_data, fetched_at, expires_at)
    VALUES (${shopUuid}, ${vinUpper}, 'carfax', ${jsonData}::jsonb, NOW(), ${expiresAt})
    ON CONFLICT (shop_id, vin) DO UPDATE SET
      report_data = ${jsonData}::jsonb,
      fetched_at = NOW(),
      expires_at = ${expiresAt}
  `;
}

function snapshotToResult(doc: Record<string, unknown>): CarfaxResult {
  if (!doc) return { ok: false, error: "No snapshot" };
  
  // Report data is stored as JSON in report_data column
  // Handle both proper JSONB objects and legacy double-encoded strings
  let data = (doc.report_data || {}) as Record<string, unknown>;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = {}; }
  }
  
  return {
    ok: !!data.ok,
    vin: doc.vin as string ?? null,
    reportDate: data.reportDate as string ?? null,
    numberOfOwners: data.numberOfOwners as number ?? null,
    accidents: data.accidents as number ?? null,
    damageReports: data.damageReports as number ?? null,
    lastReportedMileage: data.lastReportedMileage as number ?? null,
    serviceRecords: data.serviceRecords as CarfaxServiceRecord[] ?? null,
    titleIssues: data.titleIssues as string[] ?? null,
    recalls: data.recalls as string[] ?? null,
    raw: data.raw ?? null,
    error: data.error as string ?? null,
  };
}

export async function fetchCarfaxWithCache(
  shopId: number | string,
  vin: string,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  doFetch: Fetcher = fetch
): Promise<CarfaxResult> {
  const shopIdStr = String(shopId);
  const vinUpper = vin.toUpperCase();

  // Get shop UUID from text shop_id
  const shopResult = await sql`SELECT id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1`;
  const shopUuid = shopResult[0]?.id;
  
  if (!shopUuid) {
    return { ok: false, vin: vinUpper, error: 'Shop not found' };
  }

  const result = await sql`
    SELECT * FROM carfax_reports WHERE shop_id = ${shopUuid} AND vin = ${vinUpper} LIMIT 1
  `;
  const doc = result[0];

  const now = Date.now();
  const fresh = doc?.fetched_at ? now - new Date(doc.fetched_at as string).getTime() <= maxAgeMs : false;

  if (fresh) return snapshotToResult(doc);

  const live = await fetchCarfaxLive(shopId, vin, doFetch);
  await upsertCarfaxSnapshot(shopId, vin, live);
  return live;
}
