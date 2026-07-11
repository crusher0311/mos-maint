/**
 * Smoke test for CARFAX recall parsing + merge + cache-read behavior.
 *
 * Run: `npx tsx tests/carfax-recalls.smoke.ts`
 *
 * What this guards:
 *
 * 1. `parseCarfaxRecallRecords` extracts structured recall records
 *    (NHTSA #, manufacturer recall #, description, remedy status) from
 *    `serviceHistory.displayRecords` entries with `type: "recall"`,
 *    including real-world variants: dashed NHTSA numbers ("04V-216"),
 *    emissions recalls with NO NHTSA line, and "Transport Canada#" lines.
 *
 * 2. `campaignNumbersMatch` bridges CARFAX's display form ("04V-216")
 *    and the NHTSA/DataOne canonical padded form ("04V216000").
 *
 * 3. `mergeRecallsWithCarfax` enriches matching NHTSA recalls with
 *    CARFAX remedy status and returns unmatched CARFAX recalls
 *    separately (deduped).
 *
 * 4. `getCachedCarfaxRecalls` is cache-only and works on OLD snapshots
 *    that predate recall parsing by re-parsing from the stored raw payload.
 *
 * 5. `upsertCarfaxSnapshot` persists recallRecords on the happy path and
 *    never wipes stored recall data on a failed or empty re-fetch.
 */

import {
  parseCarfaxRecallRecords,
  normalizeCampaignNumber,
  campaignNumbersMatch,
  mergeRecallsWithCarfax,
  type CarfaxRecallRecord,
} from "../lib/carfax-recalls";
import type { CarfaxResult } from "../lib/integrations/carfax";

// Stub `server-only` before importing carfax (which imports it) — same
// pattern used by tests/carfax-snapshot-preservation.smoke.ts.
const serverOnlyPath = require.resolve("server-only");
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {},
} as any;

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

let activeColl: ReturnType<typeof makeFakeCollection> | null = null;

function installMongoStub(coll: ReturnType<typeof makeFakeCollection>) {
  activeColl = coll;
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

// ----------------- fixtures (shapes verified against real cached payloads) -----------------
const rawWithRecalls = {
  serviceHistory: {
    numberOfRecallRecords: 2,
    displayRecords: [
      {
        displayDate: "05/14/2019",
        type: "service",
        text: ["Oil changed", "Odometer reported"],
      },
      {
        displayDate: "07/09/2004",
        type: "recall",
        text: [
          "Manufacturer Safety recall issued",
          "NHTSA #04V-216",
          "Recall #D22 WINDSHIELD WIPER MODULE",
          "Status: Remedy Available",
        ],
      },
      {
        displayDate: "11/30/2023",
        type: "recall",
        text: [
          "Manufacturer Emissions recall issued",
          "Recall #67A 2013-2018 D TRUCK ENGINE CALIBRATION",
          "Status: Remedy Not Yet Available",
        ],
      },
    ],
  },
};

const rawWithTransportCanada = {
  serviceHistory: {
    numberOfRecallRecords: 1,
    displayRecords: [
      {
        displayDate: "03/29/2022",
        type: "recall",
        text: [
          "Manufacturer Safety recall issued",
          "NHTSA #22V165",
          "Transport Canada# 99999",
          "Recall #N212352530 WINDSHIELD WIPER FAILURE",
          "Status: Remedy Available",
        ],
      },
    ],
  },
};

async function main() {
  console.log("CARFAX recall smoke checks");

  // ---------- 1. parseCarfaxRecallRecords ----------
  {
    const { recallRecords, numberOfRecallRecords } =
      parseCarfaxRecallRecords(rawWithRecalls);
    ok("parses exactly the type:recall entries", recallRecords?.length === 2);
    ok("carries numberOfRecallRecords through", numberOfRecallRecords === 2);

    const safety = recallRecords![0];
    ok("safety recall: NHTSA number parsed", safety.nhtsaCampaignNumber === "04V-216");
    ok("safety recall: mfr recall number parsed", safety.manufacturerRecallNumber === "D22");
    ok(
      "safety recall: description parsed",
      safety.description === "WINDSHIELD WIPER MODULE",
      safety.description ?? "null"
    );
    ok("safety recall: remedy status parsed", safety.remedyStatus === "Remedy Available");
    ok("safety recall: type = Safety", safety.recallType === "Safety");
    ok("safety recall: date carried", safety.date === "07/09/2004");

    const emissions = recallRecords![1];
    ok("emissions recall: NO NHTSA number -> null", emissions.nhtsaCampaignNumber === null);
    ok("emissions recall: mfr recall number parsed", emissions.manufacturerRecallNumber === "67A");
    ok(
      "emissions recall: 'Not Yet Available' status parsed",
      emissions.remedyStatus === "Remedy Not Yet Available"
    );
    ok("emissions recall: type = Emissions", emissions.recallType === "Emissions");
  }
  {
    const { recallRecords } = parseCarfaxRecallRecords(rawWithTransportCanada);
    const rec = recallRecords![0];
    ok("Transport Canada line ignored, NHTSA still parsed", rec.nhtsaCampaignNumber === "22V165");
    ok("long mfr recall number parsed", rec.manufacturerRecallNumber === "N212352530");
  }
  {
    const { recallRecords, numberOfRecallRecords } = parseCarfaxRecallRecords({
      serviceHistory: { displayRecords: [{ type: "service", text: ["Oil changed"] }] },
    });
    ok("no recall entries -> empty array (not null)", recallRecords?.length === 0);
    ok("missing count falls back to parsed length", numberOfRecallRecords === 0);
  }
  {
    const parsed = parseCarfaxRecallRecords({});
    ok("payload without serviceHistory -> nulls", parsed.recallRecords === null && parsed.numberOfRecallRecords === null);
  }

  // ---------- 2. campaign number matching ----------
  {
    ok("normalize strips dash + uppercases", normalizeCampaignNumber("04v-216") === "04V216");
    ok("display '04V-216' matches canonical '04V216000'", campaignNumbersMatch("04V-216", "04V216000"));
    ok("display '22V165' matches canonical '22V165000'", campaignNumbersMatch("22V165", "22V165000"));
    ok("identical numbers match", campaignNumbersMatch("21V398000", "21V398000"));
    ok("different campaigns do NOT match", !campaignNumbersMatch("04V-216", "04V217000"));
    ok("non-zero suffix does NOT match", !campaignNumbersMatch("04V216", "04V216001"));
    ok("short tokens rejected (false-positive guard)", !campaignNumbersMatch("04V", "04V000000"));
    ok("null/empty never match", !campaignNumbersMatch(null, "04V216000"));
  }

  // ---------- 3. mergeRecallsWithCarfax ----------
  {
    const nhtsa = [
      { nhtsa_campaign_number: "04V216000", component: "WIPERS" },
      { nhtsa_campaign_number: "23V999000", component: "AIRBAGS" },
    ];
    const { recallRecords } = parseCarfaxRecallRecords(rawWithRecalls);
    const { enriched, carfaxOnly } = mergeRecallsWithCarfax(nhtsa, recallRecords);

    ok("all NHTSA recalls survive the merge", enriched.length === 2);
    ok(
      "matching NHTSA recall enriched with remedy status",
      enriched[0].carfaxRemedyStatus === "Remedy Available"
    );
    ok(
      "enrichment carries mfr recall number",
      enriched[0].carfaxManufacturerRecallNumber === "D22"
    );
    ok("non-matching NHTSA recall NOT enriched", enriched[1].carfaxRemedyStatus == null);
    ok("unmatched CARFAX recall (emissions, no NHTSA #) in carfaxOnly", carfaxOnly.length === 1);
    ok("carfaxOnly entry is the emissions recall", carfaxOnly[0].manufacturerRecallNumber === "67A");
  }
  {
    // Dedup: two CARFAX records for the same unmatched campaign collapse to one.
    const dup: CarfaxRecallRecord[] = [
      {
        date: "01/01/2020", nhtsaCampaignNumber: "20V-100", manufacturerRecallNumber: "A1",
        description: "THING", remedyStatus: "Remedy Available", recallType: "Safety", text: [],
      },
      {
        date: "02/01/2020", nhtsaCampaignNumber: "20V100", manufacturerRecallNumber: "A1",
        description: "THING", remedyStatus: "Remedy Available", recallType: "Safety", text: [],
      },
    ];
    const { enriched, carfaxOnly } = mergeRecallsWithCarfax([], dup);
    ok("empty NHTSA list -> no enriched entries", enriched.length === 0);
    ok("duplicate unmatched CARFAX recalls deduped by campaign", carfaxOnly.length === 1);
  }
  {
    ok(
      "null carfax list is a no-op merge",
      mergeRecallsWithCarfax([{ nhtsa_campaign_number: "04V216000" }], null).enriched.length === 1
    );
  }

  // ---------- 4 & 5 need the (mongo-stubbed) carfax module ----------
  installMongoStub(makeFakeCollection());
  const carfaxMod = await import("../lib/integrations/carfax");
  const { getCachedCarfaxRecalls, upsertCarfaxSnapshot } = carfaxMod;

  // ---------- 4. getCachedCarfaxRecalls: cache-only read ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);

    // OLD snapshot: written before recall parsing existed — has raw only.
    fakeColl.docs.push({
      shopId: 63,
      vin: "1GYS4MKJ4GR434503",
      ok: true,
      raw: rawWithRecalls,
    });
    const fromRaw = await getCachedCarfaxRecalls(63, "1gys4mkj4gr434503");
    ok(
      "old snapshot (no recallRecords field): re-parsed from stored raw",
      fromRaw?.length === 2 && fromRaw[0].nhtsaCampaignNumber === "04V-216"
    );
    ok("VIN lookup is uppercased", fromRaw !== null);

    // NEW snapshot: has persisted recallRecords — served as-is.
    fakeColl.docs.length = 0;
    fakeColl.docs.push({
      shopId: 63,
      vin: "VINWITHSTOREDRECS",
      ok: true,
      recallRecords: [
        {
          date: "03/29/2022", nhtsaCampaignNumber: "22V165", manufacturerRecallNumber: "N212352530",
          description: "WINDSHIELD WIPER FAILURE", remedyStatus: "Remedy Available",
          recallType: "Safety", text: [],
        },
      ],
      numberOfRecallRecords: 1,
      raw: { serviceHistory: { displayRecords: [] } },
    });
    const stored = await getCachedCarfaxRecalls(63, "VINWITHSTOREDRECS");
    ok(
      "new snapshot: stored recallRecords served without re-parse",
      stored?.length === 1 && stored[0].manufacturerRecallNumber === "N212352530"
    );

    // Unhealthy snapshot -> null (never a live fetch).
    fakeColl.docs.length = 0;
    fakeColl.docs.push({ shopId: 63, vin: "BADVIN00000000000", ok: false, raw: rawWithRecalls });
    ok("ok:false snapshot -> null", (await getCachedCarfaxRecalls(63, "BADVIN00000000000")) === null);
    ok("missing snapshot -> null", (await getCachedCarfaxRecalls(63, "NOSUCHVIN00000000")) === null);
  }

  // ---------- 5. upsertCarfaxSnapshot: recall persistence + preservation ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);

    const { recallRecords, numberOfRecallRecords } = parseCarfaxRecallRecords(rawWithRecalls);
    const goodReport: CarfaxResult = {
      ok: true,
      vin: "1GYS4MKJ4GR434503",
      reportDate: "2026-05-11",
      lastReportedMileage: 87234,
      serviceRecords: [{ date: "2025-08-12", odometer: 80120, description: "Oil change" }],
      serviceCategories: null,
      recallRecords,
      numberOfRecallRecords,
      raw: rawWithRecalls,
    };

    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", goodReport);
    const storedDoc = fakeColl.docs[0];
    ok(
      "happy path persists recallRecords on the snapshot",
      Array.isArray(storedDoc.recallRecords) && storedDoc.recallRecords.length === 2
    );
    ok("happy path persists numberOfRecallRecords", storedDoc.numberOfRecallRecords === 2);

    // Failed re-fetch preserves recall data.
    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", {
      ok: false,
      error: "CARFAX 107: The VIN provided is not valid...",
      raw: { errorMessages: { errors: [{ code: 107 }] } },
    });
    ok(
      "failed re-fetch PRESERVES stored recallRecords",
      Array.isArray(fakeColl.docs[0].recallRecords) && fakeColl.docs[0].recallRecords.length === 2
    );

    // Empty-but-ok re-fetch (no recalls in it) preserves recall data too.
    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", {
      ok: true,
      vin: "1GYS4MKJ4GR434503",
      serviceRecords: null,
      serviceCategories: null,
      lastReportedMileage: null,
      recallRecords: null,
      numberOfRecallRecords: null,
      raw: { ok: 1 },
    });
    ok(
      "empty-but-ok re-fetch does NOT wipe stored recallRecords",
      Array.isArray(fakeColl.docs[0].recallRecords) && fakeColl.docs[0].recallRecords.length === 2
    );

    // Empty service history but FRESH recall data: recalls are taken.
    const { recallRecords: freshRecs } = parseCarfaxRecallRecords(rawWithTransportCanada);
    await upsertCarfaxSnapshot(63, "1GYS4MKJ4GR434503", {
      ok: true,
      vin: "1GYS4MKJ4GR434503",
      serviceRecords: null,
      serviceCategories: null,
      lastReportedMileage: null,
      recallRecords: freshRecs,
      numberOfRecallRecords: 1,
      raw: rawWithTransportCanada,
    });
    ok(
      "empty-but-ok re-fetch WITH fresh recalls updates recallRecords",
      fakeColl.docs[0].recallRecords?.length === 1 &&
        fakeColl.docs[0].recallRecords[0].nhtsaCampaignNumber === "22V165"
    );
    ok(
      "…and still preserves the prior serviceRecords",
      Array.isArray(fakeColl.docs[0].serviceRecords) && fakeColl.docs[0].serviceRecords.length === 1
    );

    // Recall-only snapshot (recalls but NO service records — valid real-world
    // shape): failed and empty refetches must preserve the recall data too.
    const recallOnlyColl = makeFakeCollection();
    installMongoStub(recallOnlyColl);
    const { recallRecords: onlyRecs } = parseCarfaxRecallRecords(rawWithRecalls);
    await upsertCarfaxSnapshot(63, "RECALLONLYVIN0001", {
      ok: true,
      vin: "RECALLONLYVIN0001",
      reportDate: null,
      serviceRecords: null,
      serviceCategories: null,
      lastReportedMileage: null,
      recallRecords: onlyRecs,
      numberOfRecallRecords: 2,
      raw: rawWithRecalls,
    });
    ok(
      "recall-only snapshot written with its recallRecords",
      recallOnlyColl.docs.length === 1 &&
        Array.isArray(recallOnlyColl.docs[0].recallRecords) &&
        recallOnlyColl.docs[0].recallRecords.length === 2
    );

    await upsertCarfaxSnapshot(63, "RECALLONLYVIN0001", {
      ok: false,
      error: "CARFAX 107: The VIN provided is not valid...",
      raw: { errorMessages: { errors: [{ code: 107 }] } },
    });
    ok(
      "FAILED refetch preserves recall-only snapshot's recallRecords",
      Array.isArray(recallOnlyColl.docs[0].recallRecords) &&
        recallOnlyColl.docs[0].recallRecords.length === 2
    );
    ok(
      "FAILED refetch keeps ok:true on recall-only snapshot",
      recallOnlyColl.docs[0].ok === true
    );

    await upsertCarfaxSnapshot(63, "RECALLONLYVIN0001", {
      ok: true,
      vin: "RECALLONLYVIN0001",
      serviceRecords: null,
      serviceCategories: null,
      lastReportedMileage: null,
      recallRecords: null,
      numberOfRecallRecords: null,
      raw: { ok: 1 },
    });
    ok(
      "EMPTY-but-ok refetch preserves recall-only snapshot's recallRecords",
      Array.isArray(recallOnlyColl.docs[0].recallRecords) &&
        recallOnlyColl.docs[0].recallRecords.length === 2
    );
    ok(
      "EMPTY-but-ok refetch stamps lastEmptyFetchAt on recall-only snapshot",
      recallOnlyColl.docs[0].lastEmptyFetchAt instanceof Date
    );

    // First-ever failure: recall fields explicitly null (canonical failure doc).
    const fresh = makeFakeCollection();
    installMongoStub(fresh);
    await upsertCarfaxSnapshot(63, "NEWVINNEVERSEEN17", {
      ok: false,
      error: "CARFAX 107",
      raw: {},
    });
    ok(
      "first-ever failure doc has recallRecords:null",
      fresh.docs[0].recallRecords === null && fresh.docs[0].numberOfRecallRecords === null
    );
  }

  if (failed === 0) {
    console.log("\nAll CARFAX recall smoke checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failed} CARFAX recall smoke check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\ncarfax-recalls smoke crashed:", err);
  process.exit(1);
});
