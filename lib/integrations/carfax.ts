// lib/integrations/carfax.ts
import "server-only";
import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { withCache } from "@/lib/cache";

type Fetcher = typeof fetch;

/** -------- Public types returned to the UI -------- */
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
  raw?: any;
  error?: string;
};

/** -------- Config (env + per-shop locationId) -------- */
export async function resolveCarfaxConfig(shopId: number) {
  return withCache('shopConfig', `carfax:${shopId}`, async () => {
    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { carfax: 1, carfaxLocationId: 1 } }
    );

    // Per-shop location (preferred nested, fallback flat)
    const locationId =
      shop?.carfax?.locationId ??
      shop?.carfaxLocationId ??
      null;

    // ENV (same for all shops) — use ONLY these two names
    const base = (process.env.CARFAX_POST_URL || "").replace(/\/+$/, "");
    const productDataId = process.env.CARFAX_PDI || "";

    return {
      base,               // e.g. https://servicesocket.carfax.com/data/1
      productDataId,      // provided by CARFAX; same for all shops
      locationId,         // per-shop, user enters in Settings
      hasEnv: Boolean(base) && Boolean(productDataId),
      hasLocation: Boolean(locationId),
      configured: Boolean(base) && Boolean(productDataId) && Boolean(locationId),
    };
  }, 300);
}

function toInt(val: any): number | null {
  if (val == null) return null;
  const n = Number(String(val).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function nonEmpty(s: any): string | null {
  const t = s == null ? "" : String(s).trim();
  return t ? t : null;
}

/** -------- Live fetch (CARFAX Service History Check) --------
 * Per CARFAX guide, POST JSON with: { vin, productDataId, locationId }
 */
export async function fetchCarfaxLive(
  shopId: number,
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
  trackApiRequest('carfax', '/data', 'POST', res.status, latencyMs, shopId).catch(() => {});

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
  }

  const json = await res.json().catch(() => null);
  if (!json || typeof json !== "object") {
    return { ok: false, error: "Invalid JSON from CARFAX." };
  }

  // ---- Normalize common shapes from CARFAX ----
  // Some responses are { report: {...} }, some { data: {...} }, and some (like yours) root-level.
  const root: any = json?.report || json?.data || json;

  const vinOut =
    nonEmpty(root?.vin) ||
    nonEmpty(root?.vehicle?.vin) ||
    nonEmpty(root?.inputVin) ||
    nonEmpty(root?.serviceHistory?.vin) ||
    vin;

  const reportDate =
    nonEmpty(root?.reportDate) ||
    nonEmpty(root?.generatedAt) ||
    nonEmpty(root?.createdAt) ||
    null;

  const owners =
    toInt(root?.numberOfOwners) ??
    toInt(root?.ownersCount) ??
    (Array.isArray(root?.ownershipHistory) ? root.ownershipHistory.length : null);

  const accidents =
    toInt(root?.accidentCount) ??
    (Array.isArray(root?.accidents) ? root.accidents.length : null) ??
    null;

  const damageReports =
    toInt(root?.damageCount) ??
    (Array.isArray(root?.damage) ? root.damage.length : null) ??
    null;

  // ---- Build service records from a few possible shapes ----
  let serviceRecords: CarfaxServiceRecord[] | null = null;
  let lastMiles: number | null =
    toInt(root?.lastReportedMileage) ??
    toInt(root?.odometerLastReported) ??
    toInt(root?.odometer?.lastReported) ??
    null;

  // 1) Common shapes we already handled before
  const svcSrc =
    (Array.isArray(root?.serviceHistory) && root.serviceHistory) ||
    (Array.isArray(root?.serviceRecords) && root.serviceRecords) ||
    (Array.isArray(root?.services) && root.services) ||
    null;

  if (Array.isArray(svcSrc)) {
    serviceRecords = svcSrc.map((s: any) => ({
      date: nonEmpty(s?.date) || nonEmpty(s?.serviceDate) || nonEmpty(s?.reportedDate),
      odometer: toInt(s?.odometer) ?? toInt(s?.mileage),
      description: nonEmpty(s?.description) || nonEmpty(s?.details),
      location: nonEmpty(s?.location) || nonEmpty(s?.dealer) || nonEmpty(s?.source),
    }));
    // If last miles still unknown, try from this list
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

  // 2) Your payload: serviceHistory.displayRecords[]
  const disp = root?.serviceHistory?.displayRecords;
  if (Array.isArray(disp)) {
    const mapped: CarfaxServiceRecord[] = disp
      .filter((r: any) => String(r?.type || "").toLowerCase() === "service")
      .map((r: any) => ({
        date: nonEmpty(r?.displayDate),
        odometer: toInt(r?.odometer),
        description: Array.isArray(r?.text) ? r.text.map((t: any) => String(t)).join("; ") : nonEmpty(r?.text),
        location: null, // not present in this shape
      }));

    // Merge or set
    serviceRecords = Array.isArray(serviceRecords) ? [...serviceRecords, ...mapped] : mapped;

    // Derive last miles from displayRecords if we still don't have it
    if (lastMiles == null) {
      const maxFromDisplay = Math.max(
        ...disp
          .map((r: any) => toInt(r?.odometer) ?? -1)
          .filter((n: number) => n >= 0),
        -1
      );
      lastMiles = maxFromDisplay >= 0 ? maxFromDisplay : null;
    }
  }

  const titleIssues: string[] | null =
    Array.isArray(root?.titleIssues)
      ? root.titleIssues.map((x: any) => String(x)).filter(Boolean)
      : null;

  const recalls: string[] | null =
    Array.isArray(root?.recalls)
      ? root.recalls.map((r: any) => nonEmpty(r?.title || r?.name)).filter(Boolean) as string[]
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

/** -------- Snapshot storage (cache) -------- */
export async function upsertCarfaxSnapshot(
  shopId: number,
  vin: string,
  report: CarfaxResult
) {
  const db = await getDb();
  const now = new Date();
  await db.collection("carfax_reports").updateOne(
    { shopId, vin },
    {
      $set: {
        shopId,
        vin,
        fetchedAt: now,
        reportDate: report.reportDate ?? null,
        numberOfOwners: report.numberOfOwners ?? null,
        accidents: report.accidents ?? null,
        damageReports: report.damageReports ?? null,
        lastReportedMileage: report.lastReportedMileage ?? null,
        serviceRecords: report.serviceRecords ?? null,
        titleIssues: report.titleIssues ?? null,
        recalls: report.recalls ?? null,
        ok: report.ok,
        error: report.error ?? null,
        raw: report.raw ?? null,
        source: "carfax",
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

function snapshotToResult(doc: any): CarfaxResult {
  if (!doc) return { ok: false, error: "No snapshot" };
  return {
    ok: !!doc.ok,
    vin: doc.vin ?? null,
    reportDate: doc.reportDate ?? null,
    numberOfOwners: doc.numberOfOwners ?? null,
    accidents: doc.accidents ?? null,
    damageReports: doc.damageReports ?? null,
    lastReportedMileage: doc.lastReportedMileage ?? null,
    serviceRecords: doc.serviceRecords ?? null,
    titleIssues: doc.titleIssues ?? null,
    recalls: doc.recalls ?? null,
    raw: doc.raw ?? null,
    error: doc.error ?? null,
  };
}

/** Cached fetch; defaults to 7 days freshness */
export async function fetchCarfaxWithCache(
  shopId: number,
  vin: string,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  doFetch: Fetcher = fetch
): Promise<CarfaxResult> {
  const db = await getDb();
  const key = { shopId, vin };
  const doc = await db.collection("carfax_reports").findOne(key);

  const now = Date.now();
  const fresh = doc?.fetchedAt ? now - new Date(doc.fetchedAt).getTime() <= maxAgeMs : false;

  if (fresh) return snapshotToResult(doc);

  const live = await fetchCarfaxLive(shopId, vin, doFetch);
  await upsertCarfaxSnapshot(shopId, vin, live);
  return live;
}
