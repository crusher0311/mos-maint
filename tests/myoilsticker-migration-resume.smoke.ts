/**
 * Regression test (task #1181): a crash between the Mongo write and its PG
 * mirror write must NOT strand the record — a rerun reconciles PG.
 *
 * Simulates:
 *   Run 1: fresh create — Mongo shop+user succeed, pgInsertUser THROWS
 *          (dual-write enabled), run aborts.
 *   Run 2: PG healthy — rerun classifies the record as already migrated in
 *          Mongo but REPLAYS the PG shop+user inserts (reconcile path).
 *   Also: collision link whose PG update failed gets its PG tag replayed.
 *
 * Run: npm run test:myoilsticker-migration-resume
 */

import assert from "node:assert";
import { runMigration } from "../scripts/myoilsticker-migration-core";

// ------------------------- tiny in-memory Mongo -------------------------
function fakeCollection(docs: any[]) {
  const match = (doc: any, q: any) =>
    Object.entries(q ?? {}).every(([k, v]) => String(doc[k]) === String(v));
  return {
    find: (q: any = {}) => {
      const res = docs.filter((d) => match(d, q));
      const cursor = {
        sort: () => cursor,
        toArray: async () => res.map((d) => ({ ...d })),
      };
      return cursor;
    },
    findOne: async (q: any) => {
      const d = docs.find((x) => match(x, q));
      return d ? { ...d } : null;
    },
    insertOne: async (doc: any) => {
      docs.push({ ...doc });
    },
    updateOne: async (q: any, upd: any) => {
      const d = docs.find((x) => match(x, q));
      if (d && upd.$set) Object.assign(d, upd.$set);
    },
    estimatedDocumentCount: async () => docs.length,
  };
}
function fakeDb(collections: Record<string, any[]>) {
  const built: Record<string, any> = {};
  return {
    collection(name: string) {
      built[name] ??= fakeCollection((collections[name] ??= []));
      return built[name];
    },
  };
}

// ------------------------------ fixtures --------------------------------
const legacyCreate = {
  _id: "leg-create-1",
  email: "fresh@example.com",
  firstName: "Fresh",
  lastName: "User",
  password: "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
  targetMile: 5000,
  targetMonth: 6,
  isEmailVerified: true,
};
const legacyCollide = {
  _id: "leg-collide-1",
  email: "existing@example.com",
  password: "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
  isEmailVerified: true,
};

const legacyData = {
  users: [legacyCreate, legacyCollide],
  customgroups: [],
  oildatas: [],
};
const mosData: Record<string, any[]> = {
  users: [
    { _id: "mos-existing-1", email: "existing@example.com", emailLower: "existing@example.com", shopId: 42 },
  ],
  shops: [],
};

// PG side: record calls; fail selectively.
const pgCalls: string[] = [];
let pgUserInsertShouldFail = true;
let pgUpdateShouldFail = true;
let nextShopId = 1000;

function deps() {
  return {
    legacyDb: fakeDb(legacyData),
    mosDb: fakeDb(mosData),
    getNextShopId: async () => ++nextShopId,
    // dual-write enabled: propagate failures like dualWritePgIdentity does
    dualWrite: async (_label: string, fn: () => Promise<unknown>) => {
      await fn();
    },
    pgInsertShop: async (doc: any) => {
      pgCalls.push(`shop:${doc.legacyOilStickerId}`);
    },
    pgInsertUser: async (u: any) => {
      if (pgUserInsertShouldFail) throw new Error("simulated PG outage");
      pgCalls.push(`user:${u.emailLower}`);
    },
    pgUpdateUserFields: async (id: string, set: any) => {
      if (pgUpdateShouldFail) throw new Error("simulated PG outage");
      pgCalls.push(`update:${id}:${set.legacyOilStickerId}`);
    },
    hashRandomPassword: async () => "$2b$10$randomrandomrandomrandom",
    newUserId: () => `uid-${Math.random().toString(36).slice(2, 8)}`,
  };
}

async function main() {
  // ---- Run 1: fresh create, Mongo succeeds, PG user insert fails --------
  let failed = false;
  try {
    await runMigration(deps(), { write: true });
  } catch (e: any) {
    failed = true;
    assert.match(e.message, /simulated PG outage/);
  }
  assert.ok(failed, "run 1 should abort on PG failure");
  // Mongo state: created shop+user exist and are tagged (the hazard).
  assert.ok(mosData.shops.some((s) => s.legacyOilStickerId === "leg-create-1"));
  const createdUser = mosData.users.find((u) => u.legacyOilStickerId === "leg-create-1");
  assert.ok(createdUser, "Mongo user was inserted before PG failed");
  assert.strictEqual(createdUser.legacyMigrationCreated, true);
  // PG has the shop but NOT the user — the exact stranded state.
  assert.ok(pgCalls.includes("shop:leg-create-1"));
  assert.ok(!pgCalls.some((c) => c.startsWith("user:")), "PG user row missing after crash");

  // ---- Run 2: PG healthy — rerun must repair PG, not skip ---------------
  pgUserInsertShouldFail = false;
  pgUpdateShouldFail = true; // collision PG update STILL failing this run
  pgCalls.length = 0;
  let failed2 = false;
  try {
    await runMigration(deps(), { write: true });
  } catch (e: any) {
    failed2 = true; // collision PG update failure aborts run 2 — after Mongo tag
    assert.match(e.message, /simulated PG outage/);
  }
  assert.ok(failed2, "run 2 aborts on the still-failing collision PG update");
  // The stranded create was reconciled into PG on the resume path:
  assert.ok(pgCalls.includes("shop:leg-create-1"), "PG shop replayed");
  assert.ok(pgCalls.includes(`user:fresh@example.com`), "PG user row repaired on rerun");
  // Collision user is now tagged in Mongo but not in PG:
  const linked = mosData.users.find((u) => u._id === "mos-existing-1");
  assert.strictEqual(linked.legacyOilStickerId, "leg-collide-1");
  assert.ok(!linked.legacyMigrationCreated, "linked user never gets created flag");

  // ---- Run 3: PG fully healthy — collision link metadata reconciled -----
  pgUpdateShouldFail = false;
  pgCalls.length = 0;
  const report = await runMigration(deps(), { write: true });
  assert.ok(
    pgCalls.includes("update:mos-existing-1:leg-collide-1"),
    "collision PG tag replayed on rerun",
  );
  assert.strictEqual(report.creates.length, 0, "no duplicate creates on rerun");
  assert.strictEqual(report.skippedAlreadyMigrated.length, 2);
  assert.strictEqual(report.pgReconciled.length, 2, "both records PG-reconciled");
  // Idempotent: still exactly one migrated shop + one migrated user in Mongo.
  assert.strictEqual(
    mosData.shops.filter((s) => s.legacyOilStickerId === "leg-create-1").length,
    1,
  );
  assert.strictEqual(
    mosData.users.filter((u) => u.legacyOilStickerId === "leg-create-1").length,
    1,
  );

  console.log("myoilsticker-migration-resume smoke: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
