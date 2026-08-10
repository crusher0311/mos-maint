// Repository for the smart-backfill-timing activity profiles (task #662).
//
// This is the ONLY layer that touches MongoDB for the feature. It reads each
// provider's organic activity (webhook/callback events) from its own
// collection, filters out our own machine bursts, builds a per-shop day/hour
// histogram, resolves the shop's timezone, derives quiet window(s) + a
// confidence score, and upserts a profile into `shop_activity_profiles`.
//
// The heavy lifting (burst filter, bucketing) runs inside the Mongo
// aggregation so only a small per-(shop,dow,hour) result returns to Node.
//
// Pure math/decision logic lives in `lib/integrations/activity-profile/*`.
import { getDb } from "@/lib/data/db";
import {
  type ActivityProfile,
  type GateDecision,
  type QuietWindow,
  type SmartTimingMode,
  applyConservativeFallbackToDecision,
  computeConfidence,
  decideQuietWindowGate,
  getConservativeFallbackWindow,
  describeGateDecision,
  deriveQuietWindows,
  emptyHistogram,
  getEnforceShopAllowlist,
  getMachineBurstThreshold,
  getQuietWindowMinConfidence,
  getSmartBackfillTimingMode,
  inferTimezoneFromUtcHistogram,
  shiftHistogramToLocal,
  timezoneOffsetHours,
} from "@/lib/integrations/activity-profile/profile";
import { inferTimezoneFromAddress } from "@/lib/integrations/activity-profile/timezone";
import { isProtractorOpsPgCanonical } from "@/lib/db/integration-ops-write-mode";
import { aggregateActivityHistogram } from "@/lib/data/repositories/pg/protractor-callback-events";

const PROFILE_COLLECTION = "shop_activity_profiles";
const DEFAULT_TZ = "America/Chicago";

export type BackfillProviderKind =
  | "tekmetric"
  | "protractor"
  | "shopware"
  | "shopmonkey";

export function getSampleWindowDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.SMART_BACKFILL_TIMING_SAMPLE_DAYS);
  if (Number.isFinite(raw) && raw >= 7 && raw <= 180) return Math.floor(raw);
  return 28;
}

/* --------------------------- activity source defs ------------------------- */

type ShopKeyKind = "mos" | "mosString" | "tek" | "tenant";

interface ActivitySource {
  // Label used in perProviderCounts.
  label: string;
  collection: string;
  // Mongo expression for the event timestamp.
  tsField: string; // the indexed field used in the $match (range)
  tsExpr: any; // expression used for bucketing (may $ifNull a fallback)
  // Mongo expression yielding the source's shop key.
  shopExpr: any;
  keyKind: ShopKeyKind;
  // Extra match clause (e.g. provider filter on the shared events collection).
  extraMatch?: Record<string, any>;
}

const SOURCES: ActivitySource[] = [
  {
    label: "protractor",
    collection: "protractor_callback_events",
    tsField: "receivedAt",
    tsExpr: "$receivedAt",
    shopExpr: "$shopId",
    keyKind: "mos",
  },
  {
    label: "tekmetric",
    collection: "tekmetric_webhook_logs",
    tsField: "receivedAt",
    tsExpr: "$receivedAt",
    shopExpr: { $ifNull: ["$data.shopId", "$data.repairOrder.shopId"] },
    keyKind: "tek",
  },
  {
    label: "shopware",
    collection: "shopware_webhook_logs",
    tsField: "receivedAt",
    tsExpr: "$receivedAt",
    shopExpr: "$tenantId",
    keyKind: "tenant",
  },
  {
    label: "shopmonkey",
    collection: "shopmonkey_work_orders",
    tsField: "updatedAt",
    tsExpr: { $ifNull: ["$updatedAt", "$fetchedAt"] },
    shopExpr: "$shopId",
    keyKind: "mosString",
  },
  {
    label: "autoflow",
    collection: "events",
    tsField: "receivedAt",
    tsExpr: { $ifNull: ["$receivedAt", "$createdAt"] },
    shopExpr: "$shopId",
    keyKind: "mos",
    extraMatch: { provider: "autoflow" },
  },
];

/* ------------------------------ aggregation ------------------------------- */

interface SourceAggRow {
  rawKey: string; // the source's shop key as a string
  hist24Utc: number[];
  dowHourUtc: number[][]; // [7][24]
  organicTotal: number;
  rawTotal: number;
  activeDays: number;
}

// Run the burst-filtered aggregation for one source over the sample window.
// Returns one accumulated row per source shop key.
async function aggregateSource(
  db: any,
  src: ActivitySource,
  since: Date,
  burstThreshold: number,
): Promise<Map<string, SourceAggRow>> {
  const match: Record<string, any> = {
    [src.tsField]: { $gte: since },
    ...(src.extraMatch || {}),
  };

  const pipeline = [
    { $match: match },
    {
      $project: {
        _shop: src.shopExpr,
        _min: { $dateTrunc: { date: src.tsExpr, unit: "minute" } },
      },
    },
    { $match: { _shop: { $ne: null }, _min: { $ne: null } } },
    { $group: { _id: { s: "$_shop", m: "$_min" }, c: { $sum: 1 } } },
    {
      $facet: {
        organic: [
          { $match: { c: { $lt: burstThreshold } } },
          {
            $group: {
              _id: {
                s: "$_id.s",
                dow: { $subtract: [{ $dayOfWeek: "$_id.m" }, 1] },
                h: { $hour: "$_id.m" },
              },
              count: { $sum: "$c" },
            },
          },
        ],
        totals: [
          { $group: { _id: "$_id.s", total: { $sum: "$c" } } },
        ],
        activeDays: [
          { $match: { c: { $lt: burstThreshold } } },
          {
            $group: {
              _id: {
                s: "$_id.s",
                d: { $dateTrunc: { date: "$_id.m", unit: "day" } },
              },
            },
          },
          { $group: { _id: "$_id.s", days: { $sum: 1 } } },
        ],
      },
    },
  ];

  const [facet] = await db
    .collection(src.collection)
    .aggregate(pipeline, { allowDiskUse: true })
    .toArray();

  const out = new Map<string, SourceAggRow>();
  const ensure = (rawKey: string): SourceAggRow => {
    let row = out.get(rawKey);
    if (!row) {
      row = {
        rawKey,
        hist24Utc: emptyHistogram(),
        dowHourUtc: Array.from({ length: 7 }, () => emptyHistogram()),
        organicTotal: 0,
        rawTotal: 0,
        activeDays: 0,
      };
      out.set(rawKey, row);
    }
    return row;
  };

  if (!facet) return out;

  for (const r of facet.organic || []) {
    const key = String(r._id.s);
    const dow = Number(r._id.dow);
    const h = Number(r._id.h);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    const row = ensure(key);
    const c = Number(r.count) || 0;
    row.hist24Utc[h] += c;
    row.dowHourUtc[dow][h] += c;
    row.organicTotal += c;
  }
  for (const r of facet.totals || []) {
    ensure(String(r._id)).rawTotal += Number(r.total) || 0;
  }
  for (const r of facet.activeDays || []) {
    ensure(String(r._id)).activeDays = Number(r.days) || 0;
  }
  return out;
}

// PG twin of aggregateSource for the protractor source, used when
// PROTRACTOR_OPS_PG_CANONICAL=1 (task #1013 — last direct Mongo reader of
// protractor_callback_events). Same SourceAggRow shape, keyed by MOS shopId.
async function aggregateProtractorSourceFromPg(
  since: Date,
  burstThreshold: number,
): Promise<Map<string, SourceAggRow>> {
  const agg = await aggregateActivityHistogram(since, burstThreshold);

  const out = new Map<string, SourceAggRow>();
  const ensure = (rawKey: string): SourceAggRow => {
    let row = out.get(rawKey);
    if (!row) {
      row = {
        rawKey,
        hist24Utc: emptyHistogram(),
        dowHourUtc: Array.from({ length: 7 }, () => emptyHistogram()),
        organicTotal: 0,
        rawTotal: 0,
        activeDays: 0,
      };
      out.set(rawKey, row);
    }
    return row;
  };

  for (const r of agg.organic) {
    const dow = Number(r.dow);
    const h = Number(r.hour);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    const row = ensure(String(r.shopId));
    const c = Number(r.count) || 0;
    row.hist24Utc[h] += c;
    row.dowHourUtc[dow][h] += c;
    row.organicTotal += c;
  }
  for (const r of agg.totals) {
    ensure(String(r.shopId)).rawTotal += Number(r.total) || 0;
  }
  for (const r of agg.activeDays) {
    ensure(String(r.shopId)).activeDays = Number(r.days) || 0;
  }
  return out;
}

/* --------------------------- shop key mapping ----------------------------- */

interface ShopMeta {
  shopId: number;
  name?: string;
  provider: BackfillProviderKind;
  timezone: string | null;
  addressTz: string | null;
}

function detectProvider(shop: any): BackfillProviderKind | null {
  const ip = String(shop.integrationProvider || "").toLowerCase();
  if (ip === "tekmetric" || ip === "protractor" || ip === "shopware" || ip === "shopmonkey") {
    return ip as BackfillProviderKind;
  }
  if (shop.tekmetric?.shopId != null || shop.tekmetricShopId != null) return "tekmetric";
  if (shop.protractor?.configured || shop.protractor?.connectionId) return "protractor";
  if (shop.shopware?.tenantId != null) return "shopware";
  if (shop.shopmonkey?.apiKey || shop.shopmonkey?.locationId) return "shopmonkey";
  return null;
}

function shopAddressTz(shop: any): string | null {
  // Best-effort across the various provider shapes the shop doc may carry.
  const loc = shop.protractor?.locations?.[0] || shop.protractor?.location || {};
  return inferTimezoneFromAddress({
    timezone: shop.timezone,
    state:
      shop.state ||
      shop.address?.state ||
      shop.tekmetric?.state ||
      loc.State ||
      loc.Province ||
      null,
    province: loc.Province || shop.province || null,
    zip:
      shop.zip ||
      shop.zipCode ||
      shop.postalCode ||
      shop.address?.zip ||
      shop.tekmetric?.postalCode ||
      loc.PostalCode ||
      loc.Zip ||
      null,
  });
}

/* ----------------------------- compute & store ---------------------------- */

export interface ComputeResult {
  computed: number;
  skipped: number;
  timezonesPopulated: number;
  sampleWindowDays: number;
  shopIds: number[];
}

export async function ensureActivityProfileIndexes(db?: any): Promise<void> {
  const handle = db || (await getDb());
  await handle
    .collection(PROFILE_COLLECTION)
    .createIndex({ shopId: 1 }, { unique: true });
}

export async function computeAndStoreProfiles(
  opts: { now?: Date; sampleWindowDays?: number } = {},
): Promise<ComputeResult> {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const sampleWindowDays = opts.sampleWindowDays ?? getSampleWindowDays();
  const since = new Date(now.getTime() - sampleWindowDays * 24 * 60 * 60 * 1000);
  const burstThreshold = getMachineBurstThreshold();

  await ensureActivityProfileIndexes(db);

  // 1) Load all shops + build provider-key → MOS-shopId maps.
  const shops = await db
    .collection("shops")
    .find(
      {},
      {
        projection: {
          shopId: 1,
          name: 1,
          timezone: 1,
          integrationProvider: 1,
          state: 1,
          province: 1,
          zip: 1,
          zipCode: 1,
          postalCode: 1,
          address: 1,
          "tekmetric.shopId": 1,
          "tekmetric.state": 1,
          "tekmetric.postalCode": 1,
          tekmetricShopId: 1,
          "protractor.configured": 1,
          "protractor.connectionId": 1,
          "protractor.locations": 1,
          "protractor.location": 1,
          "shopware.tenantId": 1,
          "shopmonkey.apiKey": 1,
          "shopmonkey.locationId": 1,
        },
      },
    )
    .toArray();

  const tekToMos = new Map<string, number>();
  const tenantToMos = new Map<string, number>();
  const shopMetas: ShopMeta[] = [];

  for (const s of shops) {
    const shopId = Number(s.shopId);
    if (!Number.isFinite(shopId)) continue;
    const tekId = s.tekmetric?.shopId ?? s.tekmetricShopId;
    if (tekId != null) tekToMos.set(String(tekId), shopId);
    if (s.shopware?.tenantId != null) {
      tenantToMos.set(String(s.shopware.tenantId), shopId);
    }
    const provider = detectProvider(s);
    if (!provider) continue;
    shopMetas.push({
      shopId,
      name: s.name,
      provider,
      timezone:
        s.timezone && /\//.test(String(s.timezone)) ? String(s.timezone) : null,
      addressTz: shopAddressTz(s),
    });
  }

  // 2) Aggregate each source once.
  const sourceAgg = new Map<string, Map<string, SourceAggRow>>();
  for (const src of SOURCES) {
    try {
      const usePg =
        src.collection === "protractor_callback_events" &&
        isProtractorOpsPgCanonical();
      sourceAgg.set(
        src.label,
        usePg
          ? await aggregateProtractorSourceFromPg(since, burstThreshold)
          : await aggregateSource(db, src, since, burstThreshold),
      );
    } catch (err: any) {
      console.warn(
        `[activity-profiles] source ${src.label} aggregation failed: ${err?.message || err}`,
      );
      sourceAgg.set(src.label, new Map());
    }
  }

  // Resolve a source row for a MOS shop, translating provider keys.
  const rowForShop = (
    label: string,
    meta: ShopMeta,
  ): SourceAggRow | undefined => {
    const map = sourceAgg.get(label);
    if (!map) return undefined;
    if (label === "tekmetric") {
      // map is keyed by provider tek id; find the tek id for this MOS shop
      for (const [tekId, mos] of tekToMos) {
        if (mos === meta.shopId) {
          const r = map.get(tekId);
          if (r) return r;
        }
      }
      return undefined;
    }
    if (label === "shopware") {
      for (const [tenant, mos] of tenantToMos) {
        if (mos === meta.shopId) {
          const r = map.get(tenant);
          if (r) return r;
        }
      }
      return undefined;
    }
    // protractor / shopmonkey / autoflow keyed by MOS shopId (number or string)
    return map.get(String(meta.shopId));
  };

  // 3) Build + upsert a profile per shop.
  const bulk: any[] = [];
  // Timezone write-back: populate shops.timezone (currently almost always
  // empty, so pace logic defaults everything to Central) with the inferred
  // zone, so the existing getPaceConfig/getShopTimezone read a real per-shop
  // timezone. ONLY when the shop has no timezone set (never overwrite an
  // operator-chosen value) and we resolved a real one from the address or the
  // activity pattern (not the Central default).
  const tzBulk: any[] = [];
  const computedShopIds: number[] = [];
  let skipped = 0;

  for (const meta of shopMetas) {
    const perProviderCounts: Record<string, number> = {};
    const hist24Utc = emptyHistogram();
    const dowHourUtc = Array.from({ length: 7 }, () => emptyHistogram());
    let organicTotal = 0;
    let rawTotal = 0;
    let activeDays = 0;

    // The shop's own provider source + its AutoFlow activity (AutoFlow feeds
    // the linked provider's profile).
    for (const label of [meta.provider as string, "autoflow"]) {
      const row = rowForShop(label, meta);
      if (!row) continue;
      perProviderCounts[label] = row.organicTotal;
      for (let h = 0; h < 24; h++) hist24Utc[h] += row.hist24Utc[h];
      for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) dowHourUtc[d][h] += row.dowHourUtc[d][h];
      }
      organicTotal += row.organicTotal;
      rawTotal += row.rawTotal;
      activeDays = Math.max(activeDays, row.activeDays);
    }

    if (organicTotal === 0) {
      skipped++;
      // Still upsert a low-confidence record so operators can see "no data".
    }

    // Timezone resolution: explicit shop tz > address > activity estimate > default.
    let timezone = meta.timezone;
    let timezoneSource: ActivityProfile["timezoneSource"] = "shop";
    if (!timezone) {
      if (meta.addressTz) {
        timezone = meta.addressTz;
        timezoneSource = "address";
      } else {
        const est = inferTimezoneFromUtcHistogram(hist24Utc);
        if (est) {
          timezone = est.timezone;
          timezoneSource = "activity";
        } else {
          timezone = DEFAULT_TZ;
          timezoneSource = "default";
        }
      }
    }

    // Persist a real inferred timezone back to the shop doc when it has none,
    // so the existing pace logic stops defaulting it to Central. Never
    // overwrite an existing value; never write the Central default itself.
    if (
      !meta.timezone &&
      (timezoneSource === "address" || timezoneSource === "activity")
    ) {
      tzBulk.push({
        updateOne: {
          filter: {
            shopId: { $in: [meta.shopId, String(meta.shopId)] as any },
            $or: [
              { timezone: { $exists: false } },
              { timezone: null },
              { timezone: "" },
            ],
          },
          update: { $set: { timezone, timezoneInferredBy: timezoneSource } },
        },
      });
    }

    const offset = timezoneOffsetHours(timezone, now);
    const hourHistogramLocal = shiftHistogramToLocal(hist24Utc, offset);
    const { windows, primary } = deriveQuietWindows(hourHistogramLocal);
    const confidence = computeConfidence({
      totalOrganicEvents: organicTotal,
      distinctActiveDays: activeDays,
      localHist: hourHistogramLocal,
      primaryQuietWindow: primary,
    });

    const profile: ActivityProfile = {
      shopId: meta.shopId,
      provider: meta.provider,
      timezone,
      timezoneSource,
      hourHistogramUtc: hist24Utc,
      hourHistogramLocal,
      dayHourHistogramUtc: dowHourUtc,
      totalOrganicEvents: organicTotal,
      totalRawEvents: rawTotal,
      machineEventsFiltered: Math.max(0, rawTotal - organicTotal),
      distinctActiveDays: activeDays,
      sampleWindowDays,
      quietWindows: windows,
      primaryQuietWindow: primary,
      confidence,
      perProviderCounts,
      computedAt: now.toISOString(),
    };

    bulk.push({
      updateOne: {
        filter: { shopId: meta.shopId },
        update: { $set: profile },
        upsert: true,
      },
    });
    computedShopIds.push(meta.shopId);
  }

  if (bulk.length) {
    await db.collection(PROFILE_COLLECTION).bulkWrite(bulk, { ordered: false });
  }

  let timezonesPopulated = 0;
  if (tzBulk.length) {
    const res = await db
      .collection("shops")
      .bulkWrite(tzBulk, { ordered: false });
    timezonesPopulated = res?.modifiedCount ?? 0;
  }

  return {
    computed: computedShopIds.length,
    skipped,
    timezonesPopulated,
    sampleWindowDays,
    shopIds: computedShopIds,
  };
}

/* -------------------------------- readers --------------------------------- */

export async function loadActivityProfileMap(
  shopIds?: number[],
): Promise<Map<number, ActivityProfile>> {
  const db = await getDb();
  const filter: Record<string, any> =
    shopIds && shopIds.length
      ? { shopId: { $in: shopIds.map((n) => Number(n)) } }
      : {};
  const docs = await db
    .collection(PROFILE_COLLECTION)
    .find(filter, { projection: { _id: 0 } })
    .toArray();
  const map = new Map<number, ActivityProfile>();
  for (const d of docs) map.set(Number(d.shopId), d as ActivityProfile);
  return map;
}

export async function getAllActivityProfiles(): Promise<ActivityProfile[]> {
  const db = await getDb();
  return (await db
    .collection(PROFILE_COLLECTION)
    .find({}, { projection: { _id: 0 } })
    .sort({ shopId: 1 })
    .toArray()) as ActivityProfile[];
}

/* --------------------------- scheduler gate hook -------------------------- */

export interface QuietWindowGateContext {
  mode: SmartTimingMode;
  minConfidence: number;
  profiles: Map<number, ActivityProfile>;
  now: Date;
  // Optional canary allowlist: when non-null, only these shop ids are actually
  // enforced (skipped); all others run on the generic schedule. null = fleet-wide.
  allowlist: Set<number> | null;
}

// Build the gate context once per cron tick. When the feature is OFF this does
// NO database read and returns an empty context, so the scheduler path is
// byte-for-byte unchanged.
export async function prepareQuietWindowGate(
  shopIds: number[],
  now: Date = new Date(),
): Promise<QuietWindowGateContext> {
  const mode = getSmartBackfillTimingMode();
  if (mode === "off") {
    return { mode, minConfidence: 0, profiles: new Map(), now, allowlist: null };
  }
  const profiles = await loadActivityProfileMap(shopIds);
  return {
    mode,
    minConfidence: getQuietWindowMinConfidence(),
    profiles,
    now,
    allowlist: getEnforceShopAllowlist(),
  };
}

// Decide (and log) whether a shop should be skipped this tick. In OFF mode it
// never skips and never logs. In OBSERVE mode it logs what it *would* do but
// never skips. Only ENFORCE mode actually skips out-of-quiet-window shops.
export function applyQuietWindowGate(
  ctx: QuietWindowGateContext,
  shopId: number,
  providerLabel: string,
): { shouldSkip: boolean; decision: GateDecision | null } {
  if (ctx.mode === "off") return { shouldSkip: false, decision: null };
  const decision = decideQuietWindowGate({
    profile: ctx.profiles.get(Number(shopId)),
    now: ctx.now,
    minConfidence: ctx.minConfidence,
  });
  // Canary allowlist: in enforce mode, only allowlisted shops are actually
  // skipped. A non-allowlisted shop still gets its decision logged (for
  // observability) but runs on the generic schedule — same as today.
  const inCanary =
    ctx.allowlist === null || ctx.allowlist.has(Number(shopId));
  const wouldSkip = ctx.mode === "enforce" && !decision.eligible;
  const shouldSkip = wouldSkip && inCanary;
  const verb =
    ctx.mode === "enforce"
      ? !inCanary
        ? decision.eligible
          ? "ALLOW(not-in-canary)"
          : "would-BLOCK(not-in-canary)"
        : decision.eligible
          ? "ALLOW"
          : "BLOCK"
      : decision.eligible
        ? "would-ALLOW"
        : "would-BLOCK";
  console.log(
    `[smart-timing][${ctx.mode}][${providerLabel}] ${verb} ${describeGateDecision(Number(shopId), decision)}`,
  );
  return { shouldSkip, decision };
}

// Conservative-fallback gate for HEAVY work only (task #1072): fullpage /
// initial-catch-up chunks running INLINE on the web instance. For shops where
// the smart gate falls back (no_profile / low_confidence / no_quiet_window)
// this does NOT fail open — the work is confined to the conservative default
// window (01:00–06:00 shop-local, Central when no timezone is known;
// SMART_BACKFILL_FALLBACK_WINDOW overrides). Non-fallback shops always return
// shouldSkip:false here — the standard `applyQuietWindowGate` has already made
// their call, so this adds nothing (and logs nothing) for them.
//
// Semantics mirror the standard gate: OFF never skips/logs, OBSERVE logs the
// would-BLOCK but never skips, only ENFORCE skips (respecting the
// SMART_BACKFILL_TIMING_SHOP_IDS canary allowlist).
export function applyConservativeFallbackGate(
  ctx: QuietWindowGateContext,
  shopId: number,
  providerLabel: string,
): { shouldSkip: boolean; decision: GateDecision | null } {
  if (ctx.mode === "off") return { shouldSkip: false, decision: null };
  const base = decideQuietWindowGate({
    profile: ctx.profiles.get(Number(shopId)),
    now: ctx.now,
    minConfidence: ctx.minConfidence,
  });
  // Confident-profile shops: the standard gate already decided; no overlay.
  if (!base.fallback) return { shouldSkip: false, decision: base };
  const decision = applyConservativeFallbackToDecision({
    decision: base,
    now: ctx.now,
    window: getConservativeFallbackWindow(),
  });
  const inCanary = ctx.allowlist === null || ctx.allowlist.has(Number(shopId));
  const wouldSkip = ctx.mode === "enforce" && !decision.eligible;
  const shouldSkip = wouldSkip && inCanary;
  const verb =
    ctx.mode === "enforce"
      ? !inCanary
        ? decision.eligible
          ? "ALLOW(not-in-canary)"
          : "would-BLOCK(not-in-canary)"
        : decision.eligible
          ? "ALLOW"
          : "BLOCK"
      : decision.eligible
        ? "would-ALLOW"
        : "would-BLOCK";
  console.log(
    `[smart-timing-fallback][${ctx.mode}][${providerLabel}] ${verb} ${describeGateDecision(Number(shopId), decision)}`,
  );
  return { shouldSkip, decision };
}
