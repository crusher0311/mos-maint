/**
 * Smoke test: Tekmetric incremental-sync negative cache for failed vehicle/
 * customer live fetches.
 *
 * Regression focus (code review on task #1076's merge diff): a formerly
 * valid cache entry whose TTL has expired and whose live refresh then FAILS
 * must transition into a real negative-cache doc:
 *   - recordFetchFailure must clear the stale `data` field, otherwise
 *     isFetchBackedOff (which requires `!doc.data`) never gates it and the
 *     same failing live request repeats every sync tick;
 *   - the bumped `cachedAt` must not make stale `data` look fresh to
 *     getCachedVehicle/getCachedCustomer;
 *   - a later successful fetch clears the backoff state again.
 *
 * Runs against an in-memory fake Mongo collection — no DB required.
 */

import {
  isFetchBackedOff,
  recordFetchFailure,
  getCachedVehicle,
  cacheVehicle,
} from "../lib/integrations/tekmetric/incremental-sync";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
  }
}

// Minimal fake of the Mongo surface these helpers use.
function makeFakeDb() {
  const collections = new Map<string, Map<string, any>>();
  const keyOf = (filter: any) =>
    JSON.stringify(Object.keys(filter).filter((k) => k !== "cachedAt").sort().map((k) => [k, filter[k]]));
  const coll = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    const docs = collections.get(name)!;
    return {
      async findOne(filter: any, _opts?: any) {
        const doc = docs.get(keyOf(filter)) || null;
        if (!doc) return null;
        if (filter.cachedAt?.$gt) {
          if (!doc.cachedAt || !(new Date(doc.cachedAt) > new Date(filter.cachedAt.$gt))) return null;
        }
        return { ...doc };
      },
      async findOneAndUpdate(filter: any, update: any, _opts?: any) {
        const k = keyOf(filter);
        const doc = docs.get(k) || {};
        if (update.$inc) for (const f of Object.keys(update.$inc)) doc[f] = (doc[f] || 0) + update.$inc[f];
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$unset) for (const f of Object.keys(update.$unset)) delete doc[f];
        docs.set(k, doc);
        return { ...doc };
      },
      async updateOne(filter: any, update: any, _opts?: any) {
        const k = keyOf(filter);
        const doc = docs.get(k) || {};
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$unset) for (const f of Object.keys(update.$unset)) delete doc[f];
        docs.set(k, doc);
      },
    };
  };
  return { collection: coll, _collections: collections };
}

async function main() {
  const VEHICLE = { vehicleId: 7 };
  const COLL = "tekmetric_vehicle_cache";

  console.log("expired positive entry + failed refresh becomes a gated negative entry");
  {
    const db = makeFakeDb();
    // Positive entry cached 25h ago (CACHE_TTL is hours-scale; expired for reads).
    await db.collection(COLL).updateOne(VEHICLE, {
      $set: { ...VEHICLE, data: { id: 7, vin: "1FT..." }, cachedAt: new Date(Date.now() - 25 * 3600_000) },
    });
    check("stale positive entry is not backed off before any failure", (await isFetchBackedOff(db, COLL, VEHICLE)) === false);

    // Live refresh fails.
    await recordFetchFailure(db, COLL, VEHICLE);
    const doc = await db.collection(COLL).findOne(VEHICLE);
    check("failure cleared the stale data field", doc.data === undefined);
    check("failure recorded failCount + retryAfter", doc.failCount === 1 && !!doc.retryAfter);
    check("entry is now backed off (no repeat fetch every tick)", (await isFetchBackedOff(db, COLL, VEHICLE)) === true);
    check("bumped cachedAt does NOT resurrect stale data as fresh", (await getCachedVehicle(db, VEHICLE.vehicleId)) === null);

    // Second failure escalates backoff.
    await recordFetchFailure(db, COLL, VEHICLE);
    const doc2 = await db.collection(COLL).findOne(VEHICLE);
    check("repeat failure increments failCount", doc2.failCount === 2);
    check("repeat failure extends retryAfter (exponential)", new Date(doc2.retryAfter) > new Date(doc.retryAfter));

    // Backoff expiry re-allows a live attempt.
    await db.collection(COLL).updateOne(VEHICLE, { $set: { retryAfter: new Date(Date.now() - 1000) } });
    check("expired retryAfter re-allows a live fetch", (await isFetchBackedOff(db, COLL, VEHICLE)) === false);

    // A later success clears negative state entirely.
    await cacheVehicle(db, VEHICLE.vehicleId, { id: 7, vin: "1FT..." } as any);
    const doc3 = await db.collection(COLL).findOne(VEHICLE);
    check("successful fetch restores data + clears failCount/retryAfter", !!doc3.data && doc3.failCount === undefined && doc3.retryAfter === undefined);
    check("restored entry serves reads again", (await getCachedVehicle(db, VEHICLE.vehicleId)) !== null);
    check("restored entry is not backed off", (await isFetchBackedOff(db, COLL, VEHICLE)) === false);
  }

  console.log("pure negative entry (never had data) still gates");
  {
    const db = makeFakeDb();
    await recordFetchFailure(db, COLL, VEHICLE);
    check("first-ever failure gates immediately", (await isFetchBackedOff(db, COLL, VEHICLE)) === true);
    check("negative entry never serves reads", (await getCachedVehicle(db, VEHICLE.vehicleId)) === null);
  }

  if (failures > 0) {
    console.error(`\n${failures} tekmetric-negative-cache check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll tekmetric-negative-cache checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
