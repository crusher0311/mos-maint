/**
 * Smoke test for the CARFAX snapshot upsert + in-band-error parsing in
 * `lib/integrations/carfax.ts`.
 *
 * Run: `npx tsx tests/carfax-snapshot-preservation.smoke.ts`
 *
 * Two regressions this guards against:
 *
 * 1. CARFAX returns HTTP 200 with `{ errorMessages: { errors: [{ code, message }] } }`
 *    for failures like "VIN not valid" (107) and "User does not have
 *    access to this Product" (302). Before the in-band-error guard,
 *    `fetchCarfaxLive` would return `ok: true` and an empty payload
 *    for those — which the snapshot upsert would then write over the
 *    cached good record.
 *
 * 2. `upsertCarfaxSnapshot` used to overwrite a previously-good cached
 *    snapshot with a failed/empty new fetch, destroying mileage
 *    estimation for that VIN until CARFAX returned good data again.
 *    The new behavior preserves the historical payload on failure /
 *    empty fetches and only stamps lifecycle metadata.
 */

import type {
  fetchCarfaxLive as FetchCarfaxLive,
  upsertCarfaxSnapshot as UpsertCarfaxSnapshot,
  CarfaxResult,
} from "../lib/integrations/carfax";

// Stub `server-only` before importing carfax (which imports it) — same
// pattern used by tests/plan-build-task-339.smoke.ts.
const serverOnlyPath = require.resolve("server-only");
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {},
} as any;

let fetchCarfaxLive: typeof FetchCarfaxLive;
let upsertCarfaxSnapshot: typeof UpsertCarfaxSnapshot;

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

// ----------------- in-memory Mongo fake -----------------
type Doc = Record<string, any>;

function matchesQuery(doc: Doc, query: any): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (v && typeof v === "object" && "$exists" in (v as any)) {
      if ((v as any).$exists ? !(k in doc) : k in doc) return false;
      continue;
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

function makeFakeCollection() {
  const docs: Doc[] = [];
  return {
    docs,
    findOne: async (q: any, _opts?: any) => {
      return docs.find((d) => matchesQuery(d, q)) ?? null;
    },
    updateOne: async (
      filter: any,
      update: any,
      options?: { upsert?: boolean }
    ) => {
      const idx = docs.findIndex((d) => matchesQuery(d, filter));
      if (idx >= 0) {
        if (update.$set) Object.assign(docs[idx], update.$set);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options?.upsert) {
        const newDoc: Doc = {
          ...filter,
          ...(update.$set ?? {}),
          ...(update.$setOnInsert ?? {}),
        };
        docs.push(newDoc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
  };
}

// We hot-swap the active fake collection by reassigning this ref —
// the stubbed `getDb` always returns a Db that hands out the *current*
// value, so each test block can install its own fresh collection
// without re-stubbing the module.
let activeColl: ReturnType<typeof makeFakeCollection> | null = null;

function installMongoStub(coll: ReturnType<typeof makeFakeCollection>) {
  activeColl = coll;
  // Pre-populate require.cache for the mongo module BEFORE carfax.ts
  // imports it. Has to happen the first time only — subsequent calls
  // just swap `activeColl`.
  const mongoPath = require.resolve("../lib/mongo");
  if (!require.cache[mongoPath]) {
    const fakeDb = {
      collection: (_name: string) => activeColl as any,
    };
    require.cache[mongoPath] = {
      id: mongoPath,
      filename: mongoPath,
      loaded: true,
      children: [],
      paths: [],
      exports: {
        getDb: async () => fakeDb,
      },
    } as any;
  }
}

// ----------------- fixtures -----------------
const goodReport: CarfaxResult = {
  ok: true,
  vin: "1GYS4MKJ4GR434503",
  reportDate: "2026-05-11",
  numberOfOwners: 2,
  accidents: 0,
  damageReports: 0,
  lastReportedMileage: 87234,
  serviceRecords: [
    { date: "2025-08-12", odometer: 80120, description: "Oil change" },
    { date: "2024-06-18", odometer: 71800, description: "Cabin air filter" },
    { date: "2023-04-02", odometer: 58210, description: "Brake fluid" },
  ],
  serviceCategories: [
    { serviceName: "Oil Change", date: "2025-08-12", odometer: 80120 },
  ],
  titleIssues: null,
  recalls: null,
  raw: { ok: 1 },
};

const failedReport: CarfaxResult = {
  ok: false,
  error: "CARFAX 107: The VIN provided is not valid...",
  raw: { errorMessages: { errors: [{ code: 107, message: "..." }] } },
};

const emptyButOkReport: CarfaxResult = {
  ok: true,
  vin: "1GYS4MKJ4GR434503",
  reportDate: null,
  serviceRecords: null,
  serviceCategories: null,
  lastReportedMileage: null,
  raw: { ok: 1 },
};

async function main() {
  console.log("CARFAX snapshot-preservation smoke checks");

  // Stub the Mongo client BEFORE the carfax module loads so its top-level
  // `getDb` reference (if cached) doesn't bind to a real connection.
  const initialColl = makeFakeCollection();
  installMongoStub(initialColl);
  const carfaxMod = await import("../lib/integrations/carfax");
  fetchCarfaxLive = carfaxMod.fetchCarfaxLive;
  upsertCarfaxSnapshot = carfaxMod.upsertCarfaxSnapshot;

  // ---------- 1. fetchCarfaxLive: in-band 107 -> ok:false ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);
    // Stub out resolveCarfaxConfig by env vars + a shop doc.
    process.env.CARFAX_POST_URL = "https://servicesocket.carfax.test/data/1";
    process.env.CARFAX_PDI = "TEST_PDI";
    fakeColl.docs.push({
      shopId: 999,
      vin: "PLACEHOLDER",
      carfaxLocationId: "LOC123",
    });
    // shops collection lookup uses {shopId} — make it the only doc the
    // matcher returns for that filter.
    const fakeFetch: any = async () =>
      new Response(
        JSON.stringify({
          errorMessages: {
            errors: [
              {
                code: 107,
                message:
                  "The VIN provided is not valid. Reasons may include, not 17 characters or includes special characters.",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );

    // The fake collection is shared for shops + carfax_reports — we can
    // pre-seed the shop config doc with the same `shopId` filter.
    fakeColl.docs.length = 0;
    fakeColl.docs.push({ shopId: 999, carfaxLocationId: "LOC123" });

    const result = await fetchCarfaxLive(999, "1GYS4MKJ4GR434503", fakeFetch);
    ok(
      "fetchCarfaxLive returns ok:false on in-band 107 errorMessages",
      result.ok === false,
      `got ok=${result.ok}, error=${result.error}`,
    );
    ok(
      "error string carries the CARFAX code + message",
      typeof result.error === "string" &&
        result.error.includes("107") &&
        result.error.includes("VIN provided is not valid"),
      result.error,
    );
  }

  // ---------- 2. upsertCarfaxSnapshot: happy path writes content ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);

    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", goodReport);
    ok("happy path inserts exactly one snapshot doc", fakeColl.docs.length === 1);
    const stored = fakeColl.docs[0];
    ok("stored ok=true", stored.ok === true);
    ok(
      "stored serviceRecords are the new payload",
      Array.isArray(stored.serviceRecords) && stored.serviceRecords.length === 3,
    );
    ok(
      "stored lastReportedMileage matches the new payload",
      stored.lastReportedMileage === 87234,
    );
    ok("stored fetchedAt is a Date", stored.fetchedAt instanceof Date);
    ok(
      "stored lastFetchAttemptAt is a Date",
      stored.lastFetchAttemptAt instanceof Date,
    );
  }

  // ---------- 3. upsertCarfaxSnapshot: failed fetch preserves prior payload ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);

    // Seed with the good snapshot.
    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", goodReport);
    const beforeRecords = fakeColl.docs[0].serviceRecords;
    const beforeMileage = fakeColl.docs[0].lastReportedMileage;

    // Now hit the same VIN with a 107-style failure.
    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", failedReport);

    ok("failed re-fetch does NOT add a new doc", fakeColl.docs.length === 1);
    const afterFail = fakeColl.docs[0];
    ok(
      "previously-good serviceRecords PRESERVED across a 107 failure",
      afterFail.serviceRecords === beforeRecords &&
        Array.isArray(afterFail.serviceRecords) &&
        afterFail.serviceRecords.length === 3,
    );
    ok(
      "previously-good lastReportedMileage PRESERVED across a 107 failure",
      afterFail.lastReportedMileage === beforeMileage,
    );
    ok(
      "ok flag stays true (we still trust the historical payload)",
      afterFail.ok === true,
    );
    ok(
      "failure stamps lastErrorAt for observability",
      afterFail.lastErrorAt instanceof Date,
    );
    ok(
      "failure stamps lastErrorMessage carrying the CARFAX code",
      typeof afterFail.lastErrorMessage === "string" &&
        afterFail.lastErrorMessage.includes("107"),
      afterFail.lastErrorMessage,
    );
    ok(
      "lastFetchAttemptAt advances on every fetch (success OR failure)",
      afterFail.lastFetchAttemptAt instanceof Date,
    );
  }

  // ---------- 4. upsertCarfaxSnapshot: empty 200 also preserves ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);

    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", goodReport);
    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", emptyButOkReport);

    const after = fakeColl.docs[0];
    ok(
      "empty-but-ok re-fetch PRESERVES previously-good serviceRecords",
      Array.isArray(after.serviceRecords) && after.serviceRecords.length === 3,
    );
    ok(
      "empty-but-ok re-fetch stamps lastEmptyFetchAt for observability",
      after.lastEmptyFetchAt instanceof Date,
    );
  }

  // ---------- 5. upsertCarfaxSnapshot: failure with no prior doc writes failure as canonical ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);

    await upsertCarfaxSnapshot(63, "NEWVINNEVERSEEN17", failedReport);
    ok(
      "first-ever fetch that fails inserts ONE failure doc",
      fakeColl.docs.length === 1,
    );
    const stored = fakeColl.docs[0];
    ok("first-ever failure stores ok:false", stored.ok === false);
    ok(
      "first-ever failure carries error message",
      typeof stored.error === "string" && stored.error.includes("107"),
    );
    ok(
      "first-ever failure has serviceRecords:null (nothing to preserve)",
      stored.serviceRecords === null,
    );
  }

  // ---------- 6. upsertCarfaxSnapshot: new good content overwrites old good ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);

    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", goodReport);
    const newer: CarfaxResult = {
      ...goodReport,
      lastReportedMileage: 92000,
      serviceRecords: [
        { date: "2026-05-01", odometer: 92000, description: "Tire rotation" },
        ...goodReport.serviceRecords!,
      ],
    };
    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", newer);
    const after = fakeColl.docs[0];
    ok(
      "fresh good payload overwrites old good payload (length grew)",
      Array.isArray(after.serviceRecords) && after.serviceRecords.length === 4,
    );
    ok(
      "fresh good payload updates lastReportedMileage",
      after.lastReportedMileage === 92000,
    );
  }

  if (failed === 0) {
    console.log("\nAll CARFAX snapshot-preservation smoke checks passed.");
    process.exit(0);
  } else {
    console.error(
      `\n${failed} CARFAX snapshot-preservation smoke check(s) failed.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\ncarfax-snapshot-preservation smoke crashed:", err);
  process.exit(1);
});
