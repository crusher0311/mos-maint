// lib/integrations/carfax.ts
import "server-only";
import type { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { invalidateShopPlanCache } from "@/lib/plan-cache";
import {
  parseCarfaxRecallRecords,
  type CarfaxRecallRecord,
} from "@/lib/carfax-recalls";

export type { CarfaxRecallRecord } from "@/lib/carfax-recalls";

type Fetcher = typeof fetch;

/** -------- Public types returned to the UI -------- */
export type CarfaxServiceRecord = {
  date?: string | null;
  odometer?: number | null;
  description?: string | null;
  location?: string | null;
};

export type CarfaxServiceCategory = {
  serviceName: string;
  date: string | null;
  odometer: number | null;
};

export type CarfaxResult = {
  ok: boolean;
  vin?: string | null;
  reportDate?: string | null;
  // VHR-only fields (numberOfOwners/accidents/damageReports/titleIssues/
  // recalls) belong to CARFAX's full Vehicle History Report product and never
  // appear in the Service History Check payloads we receive — they are always
  // null here. Kept nullable for compatibility with old snapshots/consumers.
  numberOfOwners?: number | null;
  accidents?: number | null;
  damageReports?: number | null;
  lastReportedMileage?: number | null;
  serviceRecords?: CarfaxServiceRecord[] | null;
  serviceCategories?: CarfaxServiceCategory[] | null;
  titleIssues?: string[] | null;
  /** Legacy VHR-only field — always null (see note above). Recall data from
   * Service History Check payloads lives in `recallRecords` instead. */
  recalls?: string[] | null;
  /** Structured recall records parsed from serviceHistory.displayRecords. */
  recallRecords?: CarfaxRecallRecord[] | null;
  /** CARFAX's own recall count (serviceHistory.numberOfRecallRecords). */
  numberOfRecallRecords?: number | null;
  raw?: any;
  error?: string;
};

/**
 * Writes a shop's CARFAX Location ID and, when the ID is newly entered or
 * changed (transition from empty/old -> a non-empty value), clears the shop's
 * plan cache so every vehicle's plan rebuilds WITH CARFAX service history on
 * next view. This is the standard behaviour: if CARFAX is added after plans
 * were already built, those CARFAX-less plans are stale and must be discarded.
 *
 * Returns `cleared` with the deleted-row counts when a rebuild was triggered,
 * or `null` when nothing changed (e.g. re-saving the same id, or clearing it).
 */
export async function setShopCarfaxLocationId(
  db: Db,
  shopId: number,
  locationId: string,
): Promise<{
  ok: true;
  cleared: { cachedPlans: number; analysisCache: number } | null;
}> {
  const loc = String(locationId || "").trim();

  const existing = await db
    .collection("shops")
    .findOne({ shopId }, { projection: { carfax: 1, carfaxLocationId: 1 } });
  const prevLoc = String(
    existing?.carfax?.locationId || existing?.carfaxLocationId || "",
  ).trim();

  await db.collection("shops").updateOne(
    { shopId },
    {
      $set: {
        carfax: { locationId: loc },
        carfaxLocationId: loc,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  let cleared: { cachedPlans: number; analysisCache: number } | null = null;
  if (loc && loc !== prevLoc) {
    cleared = await invalidateShopPlanCache(db, shopId);
  }

  return { ok: true, cleared };
}

/** -------- Config (env + per-shop locationId) -------- */
export async function resolveCarfaxConfig(shopId: number) {
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

  // Hard timeout so a stalled CARFAX upstream can't hang the caller (e.g. the
  // dashboard load path fires these via Promise.all and a single hang would
  // otherwise pin a request until the socket eventually gives up). Overridable
  // via CARFAX_TIMEOUT_MS; defaults to 10s.
  const timeoutMs = Number(process.env.CARFAX_TIMEOUT_MS) || 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await doFetch(cfg.base, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    const aborted = err?.name === "AbortError" || controller.signal.aborted;
    // status 0 marks a transport-level failure (timeout/network) in usage stats.
    trackApiRequest('carfax', '/data', 'POST', 0, latencyMs, shopId).catch(() => {});
    return {
      ok: false,
      error: aborted
        ? `CARFAX request timed out after ${timeoutMs}ms`
        : `CARFAX request failed: ${err?.message || String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }

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

  // ---- In-band error envelope ----
  // CARFAX returns HTTP 200 with `{ errorMessages: { errors: [{ code, message }] } }`
  // for failures like:
  //   - 107 "The VIN provided is not valid..."
  //   - 302 "User does not have access to this Product"
  // Without this guard the parser below would happily walk a body with no
  // service records and stamp `ok: true` on the snapshot, overwriting any
  // previously-good cached report and silently corrupting downstream
  // mileage estimation. We surface these as `ok: false` with the upstream
  // code+message so callers (and the snapshot upsert) treat them as
  // outright failures.
  const inBandErrors =
    json?.errorMessages?.errors ||
    json?.report?.errorMessages?.errors ||
    json?.data?.errorMessages?.errors;
  if (Array.isArray(inBandErrors) && inBandErrors.length > 0) {
    const first = inBandErrors[0] || {};
    const code = first?.code != null ? String(first.code) : "?";
    const message = nonEmpty(first?.message) || "Unknown CARFAX error";
    return {
      ok: false,
      error: `CARFAX ${code}: ${message}`,
      raw: json,
    };
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

  // VHR-only fields: numberOfOwners / accidents / damageReports (and, further
  // down, titleIssues / a root-level `recalls` array) belong to CARFAX's full
  // Vehicle History Report product. The Service History Check payloads this
  // integration receives NEVER contain them (verified across 51k+ cached
  // reports), so we no longer pretend to parse them. They remain in
  // CarfaxResult as nullable for compatibility with old snapshots and
  // downstream consumers.
  const owners: number | null = null;
  const accidents: number | null = null;
  const damageReports: number | null = null;

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

  // CARFAX provides a `serviceCategories` summary that is its own
  // pre-classified rollup of "what was last performed in each category"
  // (e.g. "Tire rotation", "Oil change/Engine oil filter"). This is more
  // accurate than re-parsing the per-record free text descriptions because
  // CARFAX often groups manufacturer-scheduled services (like a 60k mile
  // service) under multiple categories without repeating each line item in
  // the displayRecords text. See lib/plan-build/triage.ts for how this is
  // merged with shop history + per-record matches.
  const rawCategories = root?.serviceHistory?.serviceCategories;
  const serviceCategories: CarfaxServiceCategory[] | null = Array.isArray(rawCategories)
    ? rawCategories
        .map((c: any): CarfaxServiceCategory | null => {
          const name = nonEmpty(c?.serviceName);
          if (!name) return null;
          return {
            serviceName: name,
            date: nonEmpty(c?.dateOfLastService),
            odometer: toInt(c?.odometerOfLastService),
          };
        })
        .filter((c): c is CarfaxServiceCategory => c !== null)
    : null;

  // VHR-only (see note above): titleIssues and a root-level `recalls` array
  // never exist in Service History Check payloads. Real recall data arrives
  // as `type: "recall"` entries inside serviceHistory.displayRecords and is
  // parsed into `recallRecords` below.
  const titleIssues: string[] | null = null;
  const recalls: string[] | null = null;

  const { recallRecords, numberOfRecallRecords } = parseCarfaxRecallRecords(root);

  return {
    ok: true,
    vin: vinOut ?? vin,
    reportDate,
    numberOfOwners: owners ?? null,
    accidents: accidents ?? null,
    damageReports: damageReports ?? null,
    lastReportedMileage: lastMiles ?? null,
    serviceRecords: serviceRecords ?? null,
    serviceCategories: serviceCategories ?? null,
    titleIssues: titleIssues ?? null,
    recalls: recalls ?? null,
    recallRecords: recallRecords ?? null,
    numberOfRecallRecords: numberOfRecallRecords ?? null,
    raw: json,
  };
}

/** -------- Decode hint extracted from a cached CARFAX report --------
 * RepairLink-style trim/engine accuracy without a paid build-sheet API:
 * CARFAX's Service History response includes a `serviceHistory.model` field
 * that bakes the trim into the model string ("VERSA SV", "MUSTANG GT") plus
 * `engineInformation` and `driveline`. When the fleet already has a cached
 * CARFAX report (we paid for it), we can mine those fields and feed them
 * back to the DataOne decoder as a disambiguation hint — closing the gap
 * for ambiguous VIN squishes (e.g. 2018 Versa S/S Plus/SV). Cache-only;
 * never triggers a live CARFAX fetch.
 */
export type CarfaxDecodeHint = {
  trim?: string | null;
  engineDescription?: string | null;
};

export async function getCarfaxDecodeHint(
  shopId: number,
  vin: string,
  modelName?: string | null,
): Promise<CarfaxDecodeHint | null> {
  if (!shopId || !vin) return null;
  const db = await getDb();
  const doc = await db
    .collection("carfax_reports")
    .findOne({ shopId, vin: vin.toUpperCase() });
  if (!doc?.ok || !doc?.raw?.serviceHistory) return null;

  const sh = doc.raw.serviceHistory as {
    model?: string;
    engineInformation?: string;
  };

  // Parse trim by stripping the canonical model name from the front of
  // CARFAX's combined "MODEL TRIM" string. "VERSA SV" + model "Versa" → "SV".
  // If we don't know the canonical model, fall back to: take everything
  // after the first whitespace token (works for single-word models; fails
  // gracefully for "GRAND CARAVAN SXT" where caller should pass modelName).
  let trim: string | null = null;
  const cfModel = nonEmpty(sh.model)?.toUpperCase() ?? null;
  if (cfModel) {
    const canonical = nonEmpty(modelName)?.toUpperCase() ?? null;
    if (canonical && cfModel.startsWith(canonical)) {
      const rest = cfModel.slice(canonical.length).trim();
      if (rest) trim = rest;
    } else {
      // No canonical model passed — best-effort: drop first token.
      const parts = cfModel.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) trim = parts.slice(1).join(" ");
    }
  }

  const hint: CarfaxDecodeHint = {
    trim,
    engineDescription: nonEmpty(sh.engineInformation),
  };
  // Return null when nothing useful was extracted so callers can short-circuit.
  if (!hint.trim && !hint.engineDescription) return null;
  return hint;
}

/** -------- Snapshot storage (cache) -------- */
/**
 * Upserts a CARFAX snapshot for (shopId, vin) — but never destroys a
 * previously-good cached report when the new fetch is unhealthy.
 *
 * Three cases:
 *   1. New report failed (ok:false). We keep the prior payload intact and
 *      only stamp lifecycle/error metadata: lastFetchAttemptAt,
 *      lastErrorAt, lastErrorMessage, plus rawError. The historical
 *      `serviceRecords` / `serviceCategories` / `lastReportedMileage`
 *      survive so downstream mileage estimation still has data to work
 *      with during a CARFAX outage.
 *   2. New report succeeded (ok:true) but came back empty
 *      (`serviceRecords` null/empty) AND we previously had real records.
 *      Same preservation behavior — record the empty fetch in
 *      `lastEmptyFetchAt` for observability but don't wipe the good data.
 *   3. New report succeeded with real content (or this is the first ever
 *      snapshot for the VIN). Overwrite the payload fields normally.
 *
 * Before this guard a transient CARFAX error or a single bad-response
 * 200 (in-band errorMessages, see fetchCarfaxLive) would silently
 * destroy the cached history for any VIN re-requested in that window —
 * 709 platform-wide reports were corrupted this way before the fix.
 */
export async function upsertCarfaxSnapshot(
  shopId: number,
  vin: string,
  report: CarfaxResult
) {
  const db = await getDb();
  const now = new Date();
  const coll = db.collection("carfax_reports");

  const newHasContent =
    report.ok &&
    Array.isArray(report.serviceRecords) &&
    report.serviceRecords.length > 0;

  // Failure / empty paths: read the existing doc to decide whether to
  // preserve. We can skip this read on the happy path because we'll
  // overwrite everything anyway.
  let existing: any = null;
  if (!newHasContent) {
    existing = await coll.findOne(
      { shopId, vin },
      {
        projection: {
          serviceRecords: 1,
          serviceCategories: 1,
          lastReportedMileage: 1,
          recallRecords: 1,
          numberOfRecallRecords: 1,
          ok: 1,
        },
      }
    );
  }

  const existingHasContent =
    existing &&
    existing.ok &&
    Array.isArray(existing.serviceRecords) &&
    existing.serviceRecords.length > 0;

  // Recall data is preserved independently of service history: a snapshot can
  // legitimately have recall records but zero service records (e.g. a vehicle
  // with an open recall and no reported service). A failed or empty refetch
  // must never wipe stored recall data either.
  const existingHasRecallContent =
    existing &&
    existing.ok &&
    Array.isArray(existing.recallRecords) &&
    existing.recallRecords.length > 0;

  const existingHasAnyContent = existingHasContent || existingHasRecallContent;

  // Common lifecycle fields that always update on a fetch attempt.
  const lifecycle: Record<string, any> = {
    shopId,
    vin,
    source: "carfax",
    lastFetchAttemptAt: now,
  };

  if (!report.ok) {
    // Case 1: new fetch failed.
    const setFields: Record<string, any> = {
      ...lifecycle,
      lastErrorAt: now,
      lastErrorMessage: report.error ?? null,
      rawError: report.raw ?? null,
    };
    if (!existingHasAnyContent) {
      // Nothing to preserve — write the failure as the canonical state.
      setFields.fetchedAt = now;
      setFields.ok = false;
      setFields.error = report.error ?? null;
      setFields.raw = report.raw ?? null;
      setFields.serviceRecords = null;
      setFields.serviceCategories = null;
      setFields.lastReportedMileage = null;
      setFields.reportDate = null;
      setFields.numberOfOwners = null;
      setFields.accidents = null;
      setFields.damageReports = null;
      setFields.titleIssues = null;
      setFields.recalls = null;
      setFields.recallRecords = null;
      setFields.numberOfRecallRecords = null;
    }
    // else: leave ok / serviceRecords / recallRecords / etc. as the
    // previously-good values (service history OR recall data alone is
    // enough to protect the snapshot).
    await coll.updateOne(
      { shopId, vin },
      { $set: setFields, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    return;
  }

  if (!newHasContent && existingHasAnyContent) {
    // Case 2: ok:true but empty, and we have good prior data (service
    // history and/or recall records) — preserve it.
    // Recall data follows the same never-overwrite-good-with-empty rule:
    // we only write recallRecords here when the new fetch actually carries
    // some (fresh recall info is safe to take even when service records
    // came back empty); an empty/missing recall list never wipes a stored one.
    const setFields: Record<string, any> = {
      ...lifecycle,
      lastEmptyFetchAt: now,
    };
    if (Array.isArray(report.recallRecords) && report.recallRecords.length > 0) {
      setFields.recallRecords = report.recallRecords;
      setFields.numberOfRecallRecords = report.numberOfRecallRecords ?? report.recallRecords.length;
    }
    await coll.updateOne(
      { shopId, vin },
      {
        $set: setFields,
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
    return;
  }

  // Case 3: happy path — first snapshot, or new content overwrites old.
  // NOTE: this branch is also reached when the fetch was ok:true but EMPTY
  // and there was no prior good content to preserve (first-ever fetch during
  // a CARFAX degradation, or a partial payload with no
  // serviceHistory.displayRecords). We still persist it (so cache-only
  // readers have *something* and we don't refire on every view), but we
  // stamp lastEmptyFetchAt so fetchCarfaxWithCache can apply a short TTL to
  // the empty snapshot instead of the full 7-day freshness window — see
  // carfaxEmptySnapshotTtlMs. This mirrors the plan-cache oemMissing
  // pattern: one degraded moment must not poison the VIN for days.
  const emptyStamp: Record<string, any> = newHasContent
    ? {}
    : { lastEmptyFetchAt: now };
  await coll.updateOne(
    { shopId, vin },
    {
      $set: {
        ...lifecycle,
        ...emptyStamp,
        fetchedAt: now,
        reportDate: report.reportDate ?? null,
        numberOfOwners: report.numberOfOwners ?? null,
        accidents: report.accidents ?? null,
        damageReports: report.damageReports ?? null,
        lastReportedMileage: report.lastReportedMileage ?? null,
        serviceRecords: report.serviceRecords ?? null,
        serviceCategories: report.serviceCategories ?? null,
        titleIssues: report.titleIssues ?? null,
        recalls: report.recalls ?? null,
        recallRecords: report.recallRecords ?? null,
        numberOfRecallRecords: report.numberOfRecallRecords ?? null,
        ok: report.ok,
        error: report.error ?? null,
        raw: report.raw ?? null,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

/**
 * Extract recall records from a stored snapshot doc. Snapshots written before
 * recall parsing existed don't have `recallRecords`, but they DO store the raw
 * payload — so we re-parse from `raw` on read. This makes recall data work on
 * all 51k+ already-cached reports with no refetch.
 */
function recallsFromSnapshotDoc(doc: any): {
  recallRecords: CarfaxRecallRecord[] | null;
  numberOfRecallRecords: number | null;
} {
  if (Array.isArray(doc?.recallRecords)) {
    return {
      recallRecords: doc.recallRecords as CarfaxRecallRecord[],
      numberOfRecallRecords: doc.numberOfRecallRecords ?? doc.recallRecords.length,
    };
  }
  const raw = doc?.raw;
  if (raw && typeof raw === "object") {
    const root = raw.report || raw.data || raw;
    return parseCarfaxRecallRecords(root);
  }
  return { recallRecords: null, numberOfRecallRecords: doc?.numberOfRecallRecords ?? null };
}

function snapshotToResult(doc: any): CarfaxResult {
  if (!doc) return { ok: false, error: "No snapshot" };
  const { recallRecords, numberOfRecallRecords } = recallsFromSnapshotDoc(doc);
  return {
    ok: !!doc.ok,
    vin: doc.vin ?? null,
    reportDate: doc.reportDate ?? null,
    numberOfOwners: doc.numberOfOwners ?? null,
    accidents: doc.accidents ?? null,
    damageReports: doc.damageReports ?? null,
    lastReportedMileage: doc.lastReportedMileage ?? null,
    serviceRecords: doc.serviceRecords ?? null,
    serviceCategories: doc.serviceCategories ?? null,
    titleIssues: doc.titleIssues ?? null,
    recalls: doc.recalls ?? null,
    recallRecords,
    numberOfRecallRecords,
    raw: doc.raw ?? null,
    error: doc.error ?? null,
  };
}

/** -------- Mileage estimation from CARFAX history -------- */
export type MileageEstimate = {
  estimated: true;
  mileage: number;
  confidence: "good" | "fair" | "low" | "very-low";
  dataPoints: number;
  lastRecordedMileage: number;
  lastRecordedDate: string;
  milesPerDay: number;
} | {
  estimated: false;
  mileage: null;
  reason: string;
};

/**
 * Cache-only read of the stored CARFAX service records for a (shopId, vin).
 *
 * Returns the persisted `serviceRecords` from the cached snapshot only — it
 * NEVER triggers a live (paid) CARFAX fetch. Used by the "last performed"
 * lookup (Task #743) to match a searched job against real CARFAX history.
 * Returns `[]` when there is no healthy cached report.
 */
export async function getCachedCarfaxServiceRecords(
  shopId: number,
  vin: string
): Promise<CarfaxServiceRecord[]> {
  if (!shopId || !vin) return [];
  const db = await getDb();
  const doc = await db
    .collection("carfax_reports")
    .findOne({ shopId, vin: vin.toUpperCase() });
  if (!doc?.ok || !Array.isArray(doc.serviceRecords)) return [];
  return doc.serviceRecords as CarfaxServiceRecord[];
}

/**
 * Cache-only read of the stored CARFAX recall records for a (shopId, vin).
 *
 * NEVER triggers a live (paid) CARFAX fetch. For snapshots written before
 * recall parsing existed, the records are re-parsed from the stored raw
 * payload (see `recallsFromSnapshotDoc`). Returns `null` when there is no
 * healthy cached report or the report carries no recall data.
 */
export async function getCachedCarfaxRecalls(
  shopId: number,
  vin: string
): Promise<CarfaxRecallRecord[] | null> {
  if (!shopId || !vin) return null;
  const db = await getDb();
  const doc = await db.collection("carfax_reports").findOne(
    { shopId, vin: vin.toUpperCase() },
    { projection: { ok: 1, recallRecords: 1, numberOfRecallRecords: 1, raw: 1 } }
  );
  if (!doc?.ok) return null;
  const { recallRecords } = recallsFromSnapshotDoc(doc);
  return recallRecords;
}

export async function estimateMileageFromCarfax(
  shopId: number,
  vin: string
): Promise<MileageEstimate> {
  const db = await getDb();
  const doc = await db.collection("carfax_reports").findOne({ shopId, vin });

  if (!doc || !doc.ok || !Array.isArray(doc.serviceRecords)) {
    return { estimated: false, mileage: null, reason: "No CARFAX data available" };
  }

  const allValidRecords = doc.serviceRecords
    .filter((r: any) => {
      if (!r.date || r.odometer == null || r.odometer <= 0) return false;
      const d = new Date(r.date);
      if (isNaN(d.getTime())) return false;
      return true;
    })
    .map((r: any) => ({
      date: new Date(r.date),
      odometer: r.odometer as number,
    }))
    .sort((a: { date: Date }, b: { date: Date }) => b.date.getTime() - a.date.getTime());

  if (allValidRecords.length < 2) {
    return { estimated: false, mileage: null, reason: "Not enough CARFAX data points to estimate mileage" };
  }

  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const recentRecords = allValidRecords.filter((r: { date: Date }) => r.date >= fiveYearsAgo);

  const useRecent = recentRecords.length >= 2;
  const records = useRecent ? recentRecords.slice(0, 3) : allValidRecords.slice(0, 5);

  const newest = records[0];
  const oldest = records[records.length - 1];

  const daysBetween = (newest.date.getTime() - oldest.date.getTime()) / (1000 * 60 * 60 * 24);
  if (daysBetween < 30) {
    return { estimated: false, mileage: null, reason: "CARFAX records too close together to estimate rate" };
  }

  const milesDriven = newest.odometer - oldest.odometer;
  if (milesDriven <= 0) {
    return { estimated: false, mileage: null, reason: "CARFAX odometer readings not consistent" };
  }

  const milesPerDay = milesDriven / daysBetween;
  const daysSinceNewest = (Date.now() - newest.date.getTime()) / (1000 * 60 * 60 * 24);
  const yearsSinceNewest = daysSinceNewest / 365;

  let confidence: string;
  if (useRecent && records.length >= 3) {
    confidence = "good";
  } else if (useRecent) {
    confidence = "fair";
  } else if (yearsSinceNewest <= 8) {
    confidence = "low";
  } else {
    confidence = "very-low";
  }

  const estimatedMileage = Math.round(newest.odometer + (milesPerDay * daysSinceNewest));

  return {
    estimated: true,
    mileage: estimatedMileage,
    confidence,
    dataPoints: records.length,
    lastRecordedMileage: newest.odometer,
    lastRecordedDate: newest.date.toISOString().split("T")[0],
    milesPerDay: Math.round(milesPerDay * 10) / 10,
  };
}

/**
 * Short-TTL negative cache: after a failed/timed-out live CARFAX lookup we
 * suppress re-fetching for this window so a persistently-failing upstream
 * isn't hammered on every dashboard load (which fires these in parallel).
 * Kept intentionally short so a transient outage self-heals quickly; this is
 * a re-fetch throttle, NOT a data TTL (the 7-day snapshot freshness and the
 * "never warm CARFAX / never wipe good data" rules are untouched).
 * Overridable via CARFAX_NEGATIVE_CACHE_MS; defaults to 15 minutes.
 */
function carfaxNegativeCacheMs(): number {
  return Number(process.env.CARFAX_NEGATIVE_CACHE_MS) || 15 * 60 * 1000;
}

/**
 * Short freshness window for ok:true snapshots that carry NO service records.
 * An empty report can be legitimate (a genuinely history-less vehicle), but it
 * can also be a partial/degraded CARFAX payload that parsed cleanly to zero
 * records — and stamping such a snapshot fresh for the full 7-day TTL removes
 * the CARFAX tier of the mileage waterfall for a week (this is exactly what
 * happened to JTHBW1GG8E2070579: an empty snapshot persisted 2026-07-13, the
 * refetch on 2026-07-24 found 18 valid records). We can't cheaply tell the two
 * apart, so ALL empty-ok snapshots get a short TTL: genuinely-empty vehicles
 * cost one extra paid refetch per window (only ~200 of 65k+ cached reports are
 * empty fleet-wide, so the spend is bounded), while degraded ones self-heal
 * quickly. Overridable via CARFAX_EMPTY_TTL_MS; defaults to 6 hours.
 */
function carfaxEmptySnapshotTtlMs(): number {
  return Number(process.env.CARFAX_EMPTY_TTL_MS) || 6 * 60 * 60 * 1000;
}

/** True when a stored snapshot doc is ok:true but has no service records. */
function snapshotIsEmptyOk(doc: any): boolean {
  return Boolean(
    doc?.ok &&
      (!Array.isArray(doc.serviceRecords) || doc.serviceRecords.length === 0)
  );
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
  // Only a *healthy* snapshot counts as "fresh". A failed first-ever fetch is
  // persisted with ok:false and fetchedAt=now (see upsertCarfaxSnapshot case 1),
  // so gating on doc.ok prevents that failure from masquerading as fresh for the
  // full 7-day TTL — failures are governed by the short negative cache below.
  // Empty-but-ok snapshots only count as fresh for a short window (see
  // carfaxEmptySnapshotTtlMs) — a degraded/partial payload must not suppress
  // refetching for the full 7 days.
  const effectiveMaxAgeMs = snapshotIsEmptyOk(doc)
    ? Math.min(maxAgeMs, carfaxEmptySnapshotTtlMs())
    : maxAgeMs;
  const fresh = doc?.ok && doc?.fetchedAt
    ? now - new Date(doc.fetchedAt).getTime() <= effectiveMaxAgeMs
    : false;

  if (fresh) return snapshotToResult(doc);

  // Negative cache: if the most recent live attempt failed within the negative
  // window, don't re-fire. Serve whatever snapshot we have — which, thanks to
  // upsertCarfaxSnapshot's preservation guard, is previously-good data when it
  // existed (ok:true) or the recorded failure (ok:false) otherwise.
  const lastErrorAt = doc?.lastErrorAt ? new Date(doc.lastErrorAt).getTime() : 0;
  if (lastErrorAt && now - lastErrorAt <= carfaxNegativeCacheMs()) {
    return snapshotToResult(doc);
  }

  const live = await fetchCarfaxLive(shopId, vin, doFetch);
  await upsertCarfaxSnapshot(shopId, vin, live);
  return live;
}

/**
 * Interactive (latency-sensitive) CARFAX read used by the extension VHI
 * button path. Unlike `fetchCarfaxWithCache`, this NEVER blocks on a live
 * CARFAX call when a snapshot already exists — it serves the most recent
 * snapshot immediately (even if past `maxAgeMs`) and kicks off a
 * fire-and-forget background refresh so the next request is fresh.
 *
 * A blocking live fetch only happens when there is no snapshot at all
 * (first-ever view of this VIN), and even then the caller is expected to
 * wrap it in its own timeout budget.
 *
 * The background refresh goes through `upsertCarfaxSnapshot`, whose in-band
 * error handling guarantees a failed/empty refresh never overwrites a
 * previously-good snapshot.
 */
export async function fetchCarfaxStaleWhileRevalidate(
  shopId: number,
  vin: string,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  doFetch: Fetcher = fetch
): Promise<CarfaxResult> {
  const db = await getDb();
  const key = { shopId, vin };
  const doc = await db.collection("carfax_reports").findOne(key);

  const now = Date.now();
  // Same empty-ok short TTL as fetchCarfaxWithCache: an empty snapshot only
  // suppresses the (background) refresh briefly. The refresh here is
  // fire-and-forget, so this costs the caller no latency.
  const effectiveMaxAgeMs = snapshotIsEmptyOk(doc)
    ? Math.min(maxAgeMs, carfaxEmptySnapshotTtlMs())
    : maxAgeMs;
  const fresh = doc?.fetchedAt
    ? now - new Date(doc.fetchedAt).getTime() <= effectiveMaxAgeMs
    : false;

  if (fresh) return snapshotToResult(doc);

  // We have a (stale) snapshot — serve it instantly and refresh in the
  // background. Only a snapshot that actually exists qualifies; a doc that
  // is purely a prior failure record (no fetchedAt) falls through to the
  // blocking path below.
  if (doc?.fetchedAt) {
    void (async () => {
      try {
        const live = await fetchCarfaxLive(shopId, vin, doFetch);
        await upsertCarfaxSnapshot(shopId, vin, live);
      } catch (err: any) {
        console.warn(
          `[CARFAX] Background SWR refresh failed for shop ${shopId} vin ${vin}: ${err?.message}`
        );
      }
    })();
    return snapshotToResult(doc);
  }

  // No usable snapshot at all — must block on a live fetch.
  const live = await fetchCarfaxLive(shopId, vin, doFetch);
  await upsertCarfaxSnapshot(shopId, vin, live);
  return live;
}
