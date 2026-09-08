import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { NextRequest } from "next/server";
import { withUpstreamTimeout } from "../lib/with-upstream-timeout";

type Doc = Record<string, any>;
let beforeReportCasUpdate: ((docs: Doc[]) => void) | null = null;
let beforeReportUpsert: ((docs: Doc[]) => void) | null = null;
let afterOwnedDeliveryRead: ((docs: Doc[]) => void) | null = null;
function matches(doc: Doc, filter: Doc) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$lte" in value) {
      return new Date(doc[key]).getTime() <= new Date(value.$lte).getTime();
    }
    if (value && typeof value === "object" && "$gt" in value) {
      return new Date(doc[key]).getTime() > new Date(value.$gt).getTime();
    }
    if (value && typeof value === "object" && "$exists" in value) {
      return value.$exists ? key in doc : !(key in doc);
    }
    if (value instanceof Date) {
      return new Date(doc[key]).getTime() === value.getTime();
    }
    return doc[key] === value;
  });
}
function collection(docs: Doc[], name: string) {
  return {
    findOne: async (filter: Doc) => {
      const found = docs.find((doc) => matches(doc, filter)) ?? null;
      if (
        name === "partner_carfax_deliveries" &&
        found &&
        filter.ownerToken &&
        afterOwnedDeliveryRead
      ) {
        const hook = afterOwnedDeliveryRead;
        afterOwnedDeliveryRead = null;
        hook(docs);
      }
      return found ? { ...found } : null;
    },
    updateOne: async (filter: Doc, update: any, options?: { upsert?: boolean }) => {
      if (name === "carfax_reports" && filter.fetchedAt && beforeReportCasUpdate) {
        const hook = beforeReportCasUpdate;
        beforeReportCasUpdate = null;
        hook(docs);
      }
      const found = docs.find((doc) => matches(doc, filter));
      if (found) {
        Object.assign(found, update.$set ?? {});
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (!options?.upsert) return { matchedCount: 0, upsertedCount: 0 };
      if (name === "carfax_reports" && beforeReportUpsert) {
        const hook = beforeReportUpsert;
        beforeReportUpsert = null;
        hook(docs);
        throw Object.assign(new Error("duplicate key"), { code: 11000 });
      }
      docs.push({ ...filter, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) });
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    },
    deleteOne: async (filter: Doc) => {
      const index = docs.findIndex((doc) => matches(doc, filter));
      if (index >= 0) docs.splice(index, 1);
    },
  };
}

const reports: Doc[] = [];
const deliveries: Doc[] = [];
const cachedPlans: Doc[] = [];
const analysisCache: Doc[] = [];
const fakeDb = {
  collection: (name: string) => collection(
    name === "partner_carfax_deliveries"
      ? deliveries
      : name === "cached_plans"
        ? cachedPlans
        : name === "maintenance_analysis_cache"
          ? analysisCache
          : reports,
    name,
  ),
};

async function fakeTransaction(fn: () => Promise<void>) {
  const reportSnapshot = reports.map((doc) => structuredClone(doc));
  try {
    await fn();
  } catch (error) {
    reports.splice(0, reports.length, ...reportSnapshot);
    throw error;
  }
}
const mongoPath = require.resolve("../lib/mongo");
require.cache[mongoPath] = {
  id: mongoPath,
  filename: mongoPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    getDb: async () => fakeDb,
    getMongoClient: async () => ({
      startSession: () => ({
        withTransaction: fakeTransaction,
        endSession: async () => {},
      }),
    }),
  },
} as any;

async function main() {
  const vhiServiceSource = fs.readFileSync(
    require.resolve("../lib/external-api/partner-vhi-service"),
    "utf8",
  );
  assert.equal(
    vhiServiceSource.includes("app/api/external/vehicles"),
    false,
    "POST VHI service never imports the GET route",
  );
  assert.equal(
    vhiServiceSource.includes("registerPartnerVhiOrchestrator"),
    false,
    "VHI service has no mutable route registry",
  );
  const carfaxRouteSource = fs.readFileSync(
    require.resolve("../app/api/external/v1/carfax/reports/route"),
    "utf8",
  );
  assert.equal(
    carfaxRouteSource.includes("PARTNER_VHI_RESPONSE_TIMEOUT_MS"),
    true,
    "one-call VHI orchestration has a hard response deadline",
  );
  const deadline = await withUpstreamTimeout(
    new Promise<never>(() => {}),
    1,
    "partner-carfax-smoke",
    "deadline",
  );
  assert.equal(deadline, "deadline");
  const {
    CARFAX_INGEST_MAX_BYTES,
    __deps: ingestionDeps,
    ingestPartnerCarfaxReport,
    normalizePartnerCarfaxReport,
    validateCarfaxIngestionBody,
  } = await import("../lib/external-api/carfax-ingestion");
  let invalidationCalls = 0;
  let failNextInvalidation = false;
  ingestionDeps.invalidateCarfaxSnapshotCaches = async () => {
    invalidationCalls += 1;
    if (failNextInvalidation) {
      failNextInvalidation = false;
      throw new Error("synthetic post-commit cache failure");
    }
    return { cachedPlans: 1, analysisCache: 1 };
  };
  const { fetchCarfaxWithCache, upsertCarfaxSnapshot } = await import("../lib/integrations/carfax");
  const deliveryRepo = await import("../lib/data/repositories/partner-carfax-deliveries");
  deliveryRepo.__deps.getDb = async () => fakeDb as any;
  deliveryRepo.__deps.getMongoClient = async () => ({
    startSession: () => ({
      withTransaction: fakeTransaction,
      endSession: async () => {},
    }),
  } as any);
  const apiKeyRecords = new Map<string, Doc>();
  const apiKeyRepoPath = require.resolve("../lib/data/repositories/api-keys");
  require.cache[apiKeyRepoPath] = {
    id: apiKeyRepoPath,
    filename: apiKeyRepoPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      findApiKeyByHash: async (keyHash: string) => apiKeyRecords.get(keyHash) ?? null,
    },
  } as any;
  const {
    getAvailablePermissions,
    checkPermission,
    validateApiKey,
    validateCarfaxPermissionIdentity,
  } = await import("../lib/external-api/api-keys");

  assert(getAvailablePermissions().includes("carfax:write"), "dedicated write permission is registered");
  assert.equal(
    await checkPermission({ permissions: ["vehicles:read"] } as any, "carfax:write"),
    false,
    "read-only key cannot ingest",
  );
  assert.throws(
    () => validateCarfaxPermissionIdentity(["carfax:write"], { isPartner: false }),
    /reserved for the AppFueled/,
  );
  assert.throws(
    () => validateCarfaxPermissionIdentity(["carfax:write"], { isPartner: true, partnerId: "other" }),
    /reserved for the AppFueled/,
  );
  validateCarfaxPermissionIdentity(
    ["carfax:write"],
    { isPartner: true, partnerId: "appfueled" },
  );
  const envNames = [
    "APPFUELED_QA_API_KEY",
    "APPFUELED_API_KEY",
    "APPFUELED_QA_API_KEY_SHA256",
  ] as const;
  const previousAppFueledEnv = Object.fromEntries(
    envNames.map((name) => [name, process.env[name]]),
  );
  const hashKey = (rawKey: string) =>
    createHash("sha256").update(rawKey).digest("hex");
  const canonicalKey = (rawKey: string, overrides: Doc = {}) => ({
    shopId: 0,
    keyHash: hashKey(rawKey),
    keyPrefix: rawKey.slice(0, 16),
    name: "AppFueled",
    permissions: ["*"],
    rateLimit: 1000,
    rateLimitTier: "enterprise",
    isActive: true,
    usageCount: 0,
    createdAt: new Date(),
    createdBy: "smoke",
    isPartner: true,
    partnerId: "appfueled",
    partnerName: "AppFueled",
    ...overrides,
  });
  const validateWithMatchingAppFueledEnv = async (rawKey: string) => {
    process.env.APPFUELED_QA_API_KEY = rawKey;
    process.env.APPFUELED_API_KEY = rawKey;
    process.env.APPFUELED_QA_API_KEY_SHA256 = hashKey(rawKey);
    return validateApiKey(rawKey);
  };
  try {
    const wildcardRaw = "mos_partner_appfueled_wildcard";
    apiKeyRecords.set(hashKey(wildcardRaw), canonicalKey(wildcardRaw));
    const wildcardResult = await validateWithMatchingAppFueledEnv(wildcardRaw);
    assert.equal(wildcardResult.valid, true);
    assert.equal(wildcardResult.apiKey?.partnerId, "appfueled");
    for (const permission of ["carfax:write", "vehicles:read", "shops:read"]) {
      assert.equal(
        await checkPermission(wildcardResult.apiKey!, permission),
        true,
        `canonical wildcard key preserves ${permission}`,
      );
    }

    const narrowedRaw = "mos_partner_appfueled_narrowed";
    apiKeyRecords.set(
      hashKey(narrowedRaw),
      canonicalKey(narrowedRaw, { permissions: ["carfax:write"] }),
    );
    const narrowedResult = await validateWithMatchingAppFueledEnv(narrowedRaw);
    assert.equal(narrowedResult.valid, true);
    assert.equal(await checkPermission(narrowedResult.apiKey!, "carfax:write"), true);
    assert.equal(await checkPermission(narrowedResult.apiKey!, "vehicles:read"), false);
    assert.equal(await checkPermission(narrowedResult.apiKey!, "shops:read"), false);

    const inactiveRaw = "mos_partner_appfueled_inactive";
    apiKeyRecords.set(
      hashKey(inactiveRaw),
      canonicalKey(inactiveRaw, { isActive: false }),
    );
    assert.deepEqual(await validateWithMatchingAppFueledEnv(inactiveRaw), {
      valid: false,
      error: "API key is disabled",
    });

    const revokedRaw = "mos_partner_appfueled_revoked";
    apiKeyRecords.set(
      hashKey(revokedRaw),
      canonicalKey(revokedRaw, { revoked: true }),
    );
    assert.deepEqual(await validateWithMatchingAppFueledEnv(revokedRaw), {
      valid: false,
      error: "API key has been revoked",
    });

    const expiredRaw = "mos_partner_appfueled_expired";
    apiKeyRecords.set(
      hashKey(expiredRaw),
      canonicalKey(expiredRaw, { expiresAt: new Date(0) }),
    );
    assert.deepEqual(await validateWithMatchingAppFueledEnv(expiredRaw), {
      valid: false,
      error: "API key has expired",
    });

    assert.deepEqual(
      await validateWithMatchingAppFueledEnv("mos_partner_appfueled_unknown"),
      { valid: false, error: "API key not found" },
    );
  } finally {
    for (const name of envNames) {
      const previous = previousAppFueledEnv[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }

  const now = new Date("2026-09-01T16:00:00.000Z");
  const valid = {
    vin: "1GYS4MKJ4GR434503",
    sms: "live_api",
    smsShopId: "36",
    deliveryId: "report-1",
    retrievedAt: "2026-09-01T15:00:00.000Z",
    report: {
      vin: "1GYS4MKJ4GR434503",
      serviceHistory: {
        numberOfRecallRecords: 1,
        displayRecords: [
          { type: "service", displayDate: "08/12/2026", odometer: "87,234", text: ["Oil changed"] },
          { type: "recall", displayDate: "07/09/2026", text: ["Manufacturer Safety recall issued", "NHTSA #26V-216", "Status: Remedy Available"] },
        ],
      },
    },
  };
  const checked = validateCarfaxIngestionBody(valid, now);
  assert.equal(checked.ok, true);
  assert.equal(validateCarfaxIngestionBody({ ...valid, vin: "BAD" }, now).ok, false);
  assert.equal(validateCarfaxIngestionBody({ ...valid, retrievedAt: "2026-08-20T00:00:00Z" }, now).ok, false);
  assert.equal(validateCarfaxIngestionBody({ ...valid, report: { serviceHistory: { displayRecords: new Array(2001).fill({}) } } }, now).ok, false);
  assert.equal(Buffer.byteLength(JSON.stringify(valid)) < CARFAX_INGEST_MAX_BYTES, true);

  const normalized = normalizePartnerCarfaxReport(valid.report, valid.vin);
  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.equal(normalized.normalized.lastReportedMileage, 87234);
    assert.equal(normalized.normalized.serviceRecords?.length, 1);
    assert.equal(normalized.normalized.recallRecords?.length, 1);
  }
  assert.equal(normalizePartnerCarfaxReport({ ...valid.report, vin: "5GAEVCKW2KJ239591" }, valid.vin).ok, false);
  assert.equal(normalizePartnerCarfaxReport({ serviceHistory: valid.report.serviceHistory }, valid.vin).ok, false);
  assert.equal(normalizePartnerCarfaxReport({ vin: valid.vin, serviceHistory: { displayRecords: [] } }, valid.vin).ok, false);
  assert.equal(normalizePartnerCarfaxReport({ vin: valid.vin }, valid.vin).ok, false);
  assert.equal(
    normalizePartnerCarfaxReport(
      { report: { vin: valid.vin, serviceHistory: [{ date: "2026-01-01", mileage: 1000, description: "Oil" }] } },
      valid.vin,
    ).ok,
    true,
    "wrapped array shape is accepted",
  );

  const args = {
    partnerId: "appfueled",
    shopId: 36,
    body: valid,
    retrievedAt: new Date(valid.retrievedAt),
  };
  const first = await ingestPartnerCarfaxReport(args);
  if (!first.ok) throw new Error(first.error);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, "partner");
  assert.equal(reports[0].fetchedAt.toISOString(), valid.retrievedAt);
  assert.equal(reports[0].provenance.partnerId, "appfueled");
  assert.equal(invalidationCalls, 1, "material first snapshot invalidates its VIN caches");
  let paidFetches = 0;
  const cached = await fetchCarfaxWithCache(
    36,
    valid.vin,
    7 * 24 * 60 * 60 * 1000,
    (async () => {
      paidFetches += 1;
      throw new Error("paid CARFAX fetch should not run");
    }) as any,
  );
  assert.equal(cached.ok, true);
  assert.equal(paidFetches, 0, "fresh partner retrieval suppresses a paid live lookup");

  const retry = await ingestPartnerCarfaxReport(args);
  if (!retry.ok) throw new Error(retry.error);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(reports.length, 1, "duplicate is not processed twice");
  assert.equal(invalidationCalls, 1, "completed duplicate does not invalidate again");

  const mismatchedVin = "5GAEVCKW2KJ239591";
  const completedMismatch = await ingestPartnerCarfaxReport({
    ...args,
    body: {
      ...valid,
      vin: mismatchedVin,
      report: { ...valid.report, vin: mismatchedVin },
    },
  });
  assert.equal(completedMismatch.ok, false);
  if (completedMismatch.ok) throw new Error("expected completed delivery VIN mismatch");
  assert.match(completedMismatch.error, /different VIN/);

  deliveries.push({
    _id: "appfueled:36:expired-vin-fence",
    partnerId: "appfueled",
    shopId: 36,
    deliveryId: "expired-vin-fence",
    vin: valid.vin,
    status: "processing",
    ownerToken: "expired-owner",
    leaseUntil: new Date(0),
  });
  const processingMismatch = await ingestPartnerCarfaxReport({
    ...args,
    body: {
      ...valid,
      vin: mismatchedVin,
      deliveryId: "expired-vin-fence",
      report: { ...valid.report, vin: mismatchedVin },
    },
  });
  assert.equal(processingMismatch.ok, false);
  if (processingMismatch.ok) throw new Error("expected processing delivery VIN mismatch");
  assert.match(processingMismatch.error, /different VIN/);
  assert.equal(
    deliveries.find((doc) => doc.deliveryId === "expired-vin-fence")?.ownerToken,
    "expired-owner",
    "mismatched retry cannot reclaim expired processing delivery",
  );

  const identicalDelivery = {
    ...valid,
    deliveryId: "report-identical",
    retrievedAt: "2026-09-01T15:10:00.000Z",
  };
  const identicalResult = await ingestPartnerCarfaxReport({
    ...args,
    body: identicalDelivery,
    retrievedAt: new Date(identicalDelivery.retrievedAt),
  });
  if (!identicalResult.ok) throw new Error(identicalResult.error);
  assert.equal(identicalResult.stored, true, "newer retrieval refreshes snapshot freshness");
  assert.equal(invalidationCalls, 1, "identical normalized contents do not invalidate");

  // A stale-but-contract-valid delivery cannot replace a newer healthy cache.
  const priorRecords = reports[0].serviceRecords;
  reports[0].fetchedAt = new Date("2026-09-01T15:30:00.000Z");
  const stale = { ...valid, deliveryId: "report-2", retrievedAt: "2026-09-01T15:15:00.000Z" };
  const staleResult = await ingestPartnerCarfaxReport({
    ...args,
    body: stale,
    retrievedAt: new Date(stale.retrievedAt),
  });
  if (!staleResult.ok) throw new Error(staleResult.error);
  assert.equal(staleResult.ok, true);
  assert.equal(staleResult.stored, false);
  assert.equal(reports[0].serviceRecords, priorRecords);
  assert.equal(
    staleResult.carfaxReport.serviceRecords,
    priorRecords,
    "out-of-order result exposes canonical newer history, not rejected payload",
  );
  assert.equal(invalidationCalls, 1, "older snapshot does not invalidate");

  const casVin = "1HGCM82633A004352";
  reports.push({
    shopId: 36,
    vin: casVin,
    ok: true,
    fetchedAt: new Date("2026-08-01T00:00:00.000Z"),
    serviceRecords: [{ description: "old" }],
  });
  beforeReportCasUpdate = (docs) => {
    const doc = docs.find((candidate) => candidate.vin === casVin)!;
    doc.fetchedAt = new Date("2026-09-01T15:30:00.000Z");
    doc.serviceRecords = [{ description: "newer concurrent data" }];
  };
  const casResult = await upsertCarfaxSnapshot(
    36,
    casVin,
    { ...(normalized.ok ? normalized.normalized : {}), ok: true, raw: { vin: casVin } } as any,
    { source: "partner", sourceRetrievedAt: new Date("2026-09-01T15:00:00.000Z") },
  );
  assert.equal(casResult.reason, "newer_snapshot_exists");
  assert.equal(
    reports.find((doc) => doc.vin === casVin)!.serviceRecords[0].description,
    "newer concurrent data",
    "CAS miss re-reads and preserves a newer concurrent writer",
  );

  const firstVin = "2C3KA53G76H123456";
  beforeReportUpsert = (docs) => {
    docs.push({
      _id: `carfax:36:${firstVin}`,
      shopId: 36,
      vin: firstVin,
      ok: true,
      fetchedAt: new Date("2026-09-01T15:30:00.000Z"),
      serviceRecords: [{ description: "first-write winner" }],
    });
  };
  const firstRace = await upsertCarfaxSnapshot(
    36,
    firstVin,
    { ...(normalized.ok ? normalized.normalized : {}), ok: true, raw: { vin: firstVin } } as any,
    { source: "partner", sourceRetrievedAt: new Date("2026-09-01T15:00:00.000Z") },
  );
  assert.equal(firstRace.reason, "newer_snapshot_exists");
  assert.equal(
    reports.filter((doc) => doc.vin === firstVin).length,
    1,
    "deterministic first-write collision retries without duplicate snapshots",
  );

  const fencedVin = "3FAHP0HA6AR123456";
  const fencedBody = {
    ...valid,
    vin: fencedVin,
    deliveryId: "fenced-delivery",
    report: {
      vin: fencedVin,
      serviceHistory: {
        displayRecords: [
          { type: "service", displayDate: "08/12/2026", odometer: "10,000", text: ["Oil changed"] },
        ],
      },
    },
  };
  const reportsBeforeFence = structuredClone(reports);
  afterOwnedDeliveryRead = (docs) => {
    const delivery = docs.find((doc) => doc.deliveryId === "fenced-delivery")!;
    delivery.ownerToken = "new-owner-after-reclaim";
    delivery.leaseUntil = new Date(Date.now() + 60_000);
  };
  const fenced = await ingestPartnerCarfaxReport({
    ...args,
    body: fencedBody,
    retrievedAt: new Date(valid.retrievedAt),
  });
  assert.equal(fenced.ok, false);
  if (fenced.ok) throw new Error("expected fenced delivery to fail");
  assert.match(fenced.error, /retry shortly/);
  assert.deepEqual(
    reports,
    reportsBeforeFence,
    "lost-owner transaction rolls back its snapshot mutation",
  );

  const recallOnly = {
    ...valid,
    deliveryId: "report-recall-only",
    vin: "5GAEVCKW2KJ239591",
    report: {
      vin: "5GAEVCKW2KJ239591",
      serviceHistory: {
        displayRecords: [
          { type: "recall", displayDate: "08/01/2026", text: ["Manufacturer Safety recall issued", "NHTSA #26V-999"] },
        ],
      },
    },
  };
  const recallResult = await ingestPartnerCarfaxReport({
    ...args,
    body: recallOnly,
    retrievedAt: new Date(valid.retrievedAt),
  });
  if (!recallResult.ok) throw new Error(recallResult.error);
  assert.equal(recallResult.stored, true, "recall-only report is stored as healthy content");
  const recallSnapshot = reports.find((doc) => doc.vin === recallOnly.vin);
  assert.equal(recallSnapshot?.fetchedAt.toISOString(), valid.retrievedAt);
  assert.equal(invalidationCalls, 2, "material recall-only snapshot invalidates");

  // A post-commit cache failure must leave a durable pending marker. The
  // duplicate retry re-attempts invalidation and returns the committed
  // canonical report rather than writing the snapshot again.
  const recoveryVin = "1FAFP404X1F123456";
  const recoveryBody = {
    ...valid,
    vin: recoveryVin,
    deliveryId: "postcommit-recovery",
    report: {
      vin: recoveryVin,
      serviceHistory: {
        displayRecords: [
          { type: "service", displayDate: "08/20/2026", odometer: "12,345", text: ["Coolant service"] },
        ],
      },
    },
  };
  failNextInvalidation = true;
  await assert.rejects(
    ingestPartnerCarfaxReport({
      ...args,
      body: recoveryBody,
      retrievedAt: new Date(valid.retrievedAt),
    }),
    /synthetic post-commit cache failure/,
  );
  const pendingRecovery = deliveries.find((doc) => doc.deliveryId === "postcommit-recovery");
  assert.equal(pendingRecovery?.status, "completed", "snapshot transaction remains committed");
  assert.equal(pendingRecovery?.cacheInvalidationPending, true, "failed invalidation remains retryable");
  const wrongRecovery = await ingestPartnerCarfaxReport({
    ...args,
    body: {
      ...recoveryBody,
      vin: valid.vin,
      report: valid.report,
    },
    retrievedAt: new Date(valid.retrievedAt),
  });
  assert.equal(wrongRecovery.ok, false, "pending recovery rejects a different request VIN");
  assert.equal(pendingRecovery?.cacheInvalidationPending, true);
  const recovered = await ingestPartnerCarfaxReport({
    ...args,
    body: recoveryBody,
    retrievedAt: new Date(valid.retrievedAt),
  });
  if (!recovered.ok) throw new Error(recovered.error);
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.carfaxReport.vin, recoveryVin);
  assert.equal(pendingRecovery?.cacheInvalidationPending, false, "retry clears pending marker");
  assert.equal(
    reports.filter((doc) => doc.vin === recoveryVin).length,
    1,
    "post-commit recovery never rewrites the snapshot",
  );

  // Exercise the real route wrapper for auth, partner-only scoping, malformed
  // and oversized bodies, unknown shops, and cross-shop resolution.
  let shopExists = true;
  const mappingPath = require.resolve("../lib/data/repositories/appfueled-shop-mappings");
  class MappingConflict extends Error {}
  require.cache[mappingPath] = {
    id: mappingPath,
    filename: mappingPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      AppFueledMappingValidationError: MappingConflict,
      resolveAppFueledShop: async (shopIdentifier: string) => {
        if (shopIdentifier === "69") {
          return { mosShopId: 69, provider: "tekmetric" };
        }
        if (shopIdentifier === "36") {
          return shopExists
            ? { mosShopId: 36, provider: "protractor", externalShopId: "legacy-36" }
            : null;
        }
        if (!/^[1-9]\d*$/.test(shopIdentifier)) {
          throw new MappingConflict("MOS shop ID must use its exact positive decimal form");
        }
        return null;
      },
    },
  } as any;
  let vhiOutcome: "success" | "building" | "permanent" = "success";
  const vhiServicePath = require.resolve("../lib/external-api/partner-vhi-service");
  require.cache[vhiServicePath] = {
    id: vhiServicePath,
    filename: vhiServicePath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      buildPartnerVhiResponse: async (_req: any, _context: any, overrides: any) =>
        vhiOutcome === "building"
          ? Response.json({ success: false, building: true, message: "building" }, { status: 202 })
          : vhiOutcome === "permanent"
            ? Response.json({ success: false, error: "Feature not enabled" }, { status: 403 })
          : Response.json({
              success: true,
              vin: overrides.vin,
              source: "cached_plan",
              reportUrl: `https://mos.tools/report/${overrides.vin}?shopId=${overrides.shopId}`,
            }),
    },
  } as any;
  const { __deps: authDeps } = await import("../lib/external-api/middleware");
  const partnerKey = {
    shopId: 0,
    keyHash: "partner-hash",
    keyPrefix: "mos_partner_test",
    name: "AppFueled",
    permissions: ["carfax:write"],
    rateLimit: 100,
    isActive: true,
    usageCount: 0,
    createdAt: new Date(),
    createdBy: "smoke",
    isPartner: true,
    partnerId: "appfueled",
  };
  authDeps.validateApiKey = async (raw: string) => {
    if (raw === "mos_partner_valid") return { valid: true, apiKey: partnerKey };
    if (raw === "mos_under") return { valid: true, apiKey: { ...partnerKey, permissions: ["vehicles:read"] } };
    if (raw === "mos_shop") return { valid: true, apiKey: { ...partnerKey, shopId: 36, isPartner: false, partnerId: undefined } };
    if (raw === "mos_other_partner") return { valid: true, apiKey: { ...partnerKey, partnerId: "other" } };
    return { valid: false, error: "not found" };
  };
  authDeps.checkPermission = async (key: any, permission: string) => key.permissions.includes(permission);
  authDeps.checkRateLimit = async () => ({ allowed: true, remaining: 99, resetAt: new Date(Date.now() + 60_000) });
  authDeps.logApiUsage = async () => {};
  authDeps.updateApiKeyUsage = async () => {};

  const { POST } = await import("../app/api/external/v1/carfax/reports/route");
  const request = (body: string, key?: string) =>
    new NextRequest("http://localhost/api/external/v1/carfax/reports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-api-key": key } : {}),
      },
      body,
    });
  assert.equal((await POST(request(JSON.stringify(valid)))).status, 401, "missing auth is rejected");
  assert.equal((await POST(request(JSON.stringify(valid), "mos_under"))).status, 403, "missing permission is rejected");
  assert.equal((await POST(request(JSON.stringify(valid), "mos_shop"))).status, 403, "shop key cannot use partner ingestion");
  assert.equal((await POST(request(JSON.stringify(valid), "mos_other_partner"))).status, 403, "other partner keys cannot ingest AppFueled reports");
  assert.equal((await POST(request("{", "mos_partner_valid"))).status, 400, "malformed JSON is rejected");
  assert.equal(
    (await POST(request(JSON.stringify({ ...valid, report: { serviceHistory: { displayRecords: [] }, padding: "x".repeat(CARFAX_INGEST_MAX_BYTES) } }), "mos_partner_valid"))).status,
    413,
    "oversized body is rejected",
  );
  const oversizedBytes = new TextEncoder().encode(
    JSON.stringify({
      ...valid,
      report: {
        vin: valid.vin,
        serviceHistory: { displayRecords: [] },
        padding: "x".repeat(CARFAX_INGEST_MAX_BYTES),
      },
    }),
  );
  const lyingLengthRequest = new NextRequest(
    "http://localhost/api/external/v1/carfax/reports",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "1",
        authorization: "Bearer mos_partner_valid",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(oversizedBytes);
          controller.close();
        },
      }),
      duplex: "half",
    } as any,
  );
  assert.equal(
    (await POST(lyingLengthRequest)).status,
    413,
    "streaming limit rejects a body whose Content-Length understates its size",
  );
  shopExists = false;
  const routeFresh = {
    ...valid,
    deliveryId: "route-report",
    retrievedAt: new Date().toISOString(),
  };
  const missingShopId = { ...routeFresh, deliveryId: "route-missing-shop-id" };
  delete (missingShopId as Partial<typeof missingShopId>).smsShopId;
  assert.equal(
    (await POST(request(JSON.stringify(missingShopId), "mos_partner_valid"))).status,
    400,
    "missing MOS shop ID is rejected",
  );
  assert.equal(
    (await POST(request(JSON.stringify({
      ...routeFresh,
      smsShopId: "069",
      deliveryId: "route-invalid-shop-id",
    }), "mos_partner_valid"))).status,
    409,
    "invalid MOS shop ID is rejected",
  );
  const directMosShop = {
    ...routeFresh,
    smsShopId: "69",
    deliveryId: "route-direct-mos-shop",
  };
  const directMosResponse = await POST(request(JSON.stringify(directMosShop), "mos_partner_valid"));
  const directMosJson = await directMosResponse.json();
  assert.equal(directMosResponse.status, 200, "canonical MOS shop resolves without a legacy mapping");
  assert.equal(directMosJson.shopId, 69);
  assert.equal((await POST(request(JSON.stringify(routeFresh), "mos_partner_valid"))).status, 404, "unknown shop is rejected");
  shopExists = true;
  deliveries.push({
    _id: "appfueled:36:route-pending",
    partnerId: "appfueled",
    shopId: 36,
    deliveryId: "route-pending",
    status: "processing",
    stored: false,
    leaseUntil: new Date(Date.now() + 60_000),
  });
  const pending = { ...routeFresh, deliveryId: "route-pending" };
  assert.equal(
    (await POST(request(JSON.stringify(pending), "mos_partner_valid"))).status,
    409,
    "an in-progress retry receives a retryable conflict instead of false success",
  );
  deliveries.find((doc) => doc.deliveryId === "route-pending")!.leaseUntil =
    new Date(Date.now() - 1);
  assert.equal(
    (await POST(request(JSON.stringify(pending), "mos_partner_valid"))).status,
    200,
    "an interrupted delivery is reclaimed after its lease expires",
  );
  const routeResponse = await POST(request(JSON.stringify(routeFresh), "mos_partner_valid"));
  const routeJson = await routeResponse.json();
  assert.equal(routeResponse.status, 200);
  assert.equal(routeJson.shopId, 36, "partner request resolves the target shop instead of key shopId=0");
  assert.equal(routeJson.success, true);
  assert.equal(routeJson.ingestion.deliveryId, routeFresh.deliveryId);
  assert.equal(routeJson.vhi.source, "cached_plan");
  vhiOutcome = "building";
  const partialResponse = await POST(request(JSON.stringify(routeFresh), "mos_partner_valid"));
  const partialJson = await partialResponse.json();
  assert.equal(partialResponse.status, 202);
  assert.equal(partialJson.ingestion.success, true, "VHI timeout preserves committed ingestion");
  assert.equal(partialJson.ingestion.duplicate, true, "VHI retry does not write CARFAX twice");
  assert.equal(partialJson.vhi.retryable, true);
  vhiOutcome = "permanent";
  const permanentResponse = await POST(request(JSON.stringify(routeFresh), "mos_partner_valid"));
  const permanentJson = await permanentResponse.json();
  assert.equal(permanentResponse.status, 200, "permanent VHI failure does not misreport committed ingestion");
  assert.equal(permanentJson.ingestion.duplicate, true);
  assert.equal(permanentJson.vhi.retryable, false);
  assert.equal(permanentJson.vhi.httpStatus, 403);

  console.log("partner CARFAX ingestion: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});