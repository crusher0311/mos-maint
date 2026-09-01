import assert from "node:assert/strict";
import { NextRequest } from "next/server";

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
const fakeDb = {
  collection: (name: string) =>
    collection(name === "partner_carfax_deliveries" ? deliveries : reports, name),
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
  const {
    CARFAX_INGEST_MAX_BYTES,
    ingestPartnerCarfaxReport,
    normalizePartnerCarfaxReport,
    validateCarfaxIngestionBody,
  } = await import("../lib/external-api/carfax-ingestion");
  const { fetchCarfaxWithCache, upsertCarfaxSnapshot } = await import("../lib/integrations/carfax");
  const deliveryRepo = await import("../lib/data/repositories/partner-carfax-deliveries");
  deliveryRepo.__deps.getDb = async () => fakeDb as any;
  deliveryRepo.__deps.getMongoClient = async () => ({
    startSession: () => ({
      withTransaction: fakeTransaction,
      endSession: async () => {},
    }),
  } as any);
  const { getAvailablePermissions, checkPermission } = await import("../lib/external-api/api-keys");

  assert(getAvailablePermissions().includes("carfax:write"), "dedicated write permission is registered");
  assert.equal(
    await checkPermission({ permissions: ["vehicles:read"] } as any, "carfax:write"),
    false,
    "read-only key cannot ingest",
  );

  const now = new Date("2026-09-01T16:00:00.000Z");
  const valid = {
    vin: "1GYS4MKJ4GR434503",
    sms: "protractor",
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

  // Exercise the real route wrapper for auth, partner-only scoping, malformed
  // and oversized bodies, unknown shops, and cross-shop resolution.
  let shopExists = true;
  const lookupPath = require.resolve("../lib/extension-shop-lookup");
  require.cache[lookupPath] = {
    id: lookupPath,
    filename: lookupPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      findShopBySmsId: async () =>
        shopExists ? { mosShopId: 36, provider: "protractor" } : null,
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
        ...(key ? { authorization: `Bearer ${key}` } : {}),
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

  console.log("partner CARFAX ingestion: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});