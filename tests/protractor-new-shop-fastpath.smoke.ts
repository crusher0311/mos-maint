/**
 * Smoke test for the Protractor new-shop fast lane (task #548).
 *
 * Run: `npx tsx tests/protractor-new-shop-fastpath.smoke.ts`
 *
 * Locks in the selection contract of `findAndRunNewShopFastpath` in
 * `lib/integrations/protractor/sync.ts`, the every-5-min `?fastpath=newShops`
 * companion to the Tekmetric fast lane:
 *   - only Protractor-configured shops created inside the new-shop window
 *     are eligible (aged-out shops are excluded),
 *   - shops with a completed backfill are excluded; brand-new shops with no
 *     progress doc yet are kept,
 *   - the per-tick budget caps how many shops are kicked,
 *   - PROTRACTOR_NEW_SHOP_FASTPATH_DAYS tunes the window.
 *
 * The fake Mongo is swapped via the `__fastpathDeps` test seam and the
 * `runBackfill` runner is stubbed so no real backfill (or per-shop lock /
 * rate-limiter machinery) is exercised — the lock/rate-limiter behavior is
 * owned by `runProtractorBackfill`, which this fast lane delegates to.
 */

import assert from "node:assert/strict";

import { makeFakeDb } from "./utils/fake-mongo";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function run() {
  console.log("protractor new-shop fastpath smoke");

  // Import after env defaults are in place; the module reads
  // PROTRACTOR_NEW_SHOP_FASTPATH_DAYS at module load for its default, but
  // the cutoff is recomputed per call so tests can re-seed freely.
  const sync = await import("../lib/integrations/protractor/sync");
  const ORIGINAL = { ...sync.__fastpathDeps };

  const now = Date.now();
  const recent = () => new Date(now - 2 * DAY_MS); // inside 14d window
  const aged = () => new Date(now - 40 * DAY_MS); // outside 14d window

  function install(seed: Record<string, any[]>) {
    const fake = makeFakeDb(seed);
    const kicked: number[] = [];
    sync.__fastpathDeps.getDb = (async () => fake.db) as any;
    sync.__fastpathDeps.runBackfill = ((shopId: number) => {
      kicked.push(shopId);
    }) as any;
    return { fake, kicked };
  }

  function restore() {
    sync.__fastpathDeps.getDb = ORIGINAL.getDb;
    sync.__fastpathDeps.runBackfill = ORIGINAL.runBackfill;
  }

  // (1) Selects only recently-onboarded, incomplete, Protractor-configured
  //     shops. Excludes: aged-out, completed, and non-Protractor shops.
  {
    const { kicked } = install({
      shops: [
        { shopId: 1, protractor: { configured: true }, createdAt: recent() }, // eligible (no progress)
        { shopId: 2, protractor: { configured: true }, createdAt: recent() }, // completed → excluded
        { shopId: 3, protractor: { configured: true }, createdAt: aged() }, // aged out → excluded
        { shopId: 4, protractor: { configured: false }, createdAt: recent() }, // not protractor → excluded
        { shopId: 5, createdAt: recent() }, // no protractor config → excluded
      ],
      backfill_progress: [
        { shopId: 2, completed: true },
      ],
    });

    const result = await sync.findAndRunNewShopFastpath();
    ok("only shop 1 selected", result.shopIds.length === 1 && result.shopIds[0] === 1, JSON.stringify(result.shopIds));
    ok("processed count matches", result.processed === 1);
    ok("runner kicked exactly shop 1", kicked.length === 1 && kicked[0] === 1, JSON.stringify(kicked));
    restore();
  }

  // (2) Incomplete progress doc (completed !== true) is still eligible.
  {
    const { kicked } = install({
      shops: [
        { shopId: 10, protractor: { configured: true }, createdAt: recent() },
        { shopId: 11, protractor: { configured: true }, createdAt: recent() },
      ],
      backfill_progress: [
        { shopId: 10, completed: false, inProgress: false },
        { shopId: 11, inProgress: true }, // no `completed` field → still eligible
      ],
    });

    const result = await sync.findAndRunNewShopFastpath();
    ok("both incomplete shops eligible", result.processed === 2, JSON.stringify(result.shopIds));
    ok("runner kicked both", kicked.length === 2);
    restore();
  }

  // (3) Per-tick budget caps the number of shops kicked (default 3).
  {
    const { kicked } = install({
      shops: [1, 2, 3, 4, 5].map((shopId) => ({
        shopId,
        protractor: { configured: true },
        createdAt: recent(),
      })),
      backfill_progress: [],
    });

    const result = await sync.findAndRunNewShopFastpath();
    ok("budget caps at 3 shops", result.processed === 3, `processed=${result.processed}`);
    ok("runner kicked at most 3", kicked.length === 3);
    restore();
  }

  // (4) No eligible shops → empty result, runner never called.
  {
    const { kicked } = install({
      shops: [
        { shopId: 20, protractor: { configured: true }, createdAt: aged() },
      ],
      backfill_progress: [],
    });

    const result = await sync.findAndRunNewShopFastpath();
    ok("no shops processed", result.processed === 0 && result.shopIds.length === 0);
    ok("runner not called", kicked.length === 0);
    restore();
  }

  // (5) PROTRACTOR_NEW_SHOP_FASTPATH_DAYS widens the window. A shop created
  //     20 days ago is excluded at the default 14d but included at 30d. The
  //     window is read per-call, so just setting the env is enough.
  {
    const prev = process.env.PROTRACTOR_NEW_SHOP_FASTPATH_DAYS;

    // First confirm it's excluded at the default 14d window.
    {
      delete process.env.PROTRACTOR_NEW_SHOP_FASTPATH_DAYS;
      const { kicked } = install({
        shops: [
          { shopId: 30, protractor: { configured: true }, createdAt: new Date(now - 20 * DAY_MS) },
        ],
        backfill_progress: [],
      });
      const result = await sync.findAndRunNewShopFastpath();
      ok("20d-old shop excluded at default 14d window", result.processed === 0, JSON.stringify(result.shopIds));
      ok("runner not called at 14d", kicked.length === 0);
      restore();
    }

    // Then widen to 30d and confirm it's now eligible.
    {
      process.env.PROTRACTOR_NEW_SHOP_FASTPATH_DAYS = "30";
      const { kicked } = install({
        shops: [
          { shopId: 30, protractor: { configured: true }, createdAt: new Date(now - 20 * DAY_MS) },
        ],
        backfill_progress: [],
      });
      const result = await sync.findAndRunNewShopFastpath();
      ok("20d-old shop eligible at 30d window", result.processed === 1 && result.shopIds[0] === 30, JSON.stringify(result.shopIds));
      ok("runner kicked shop 30", kicked.length === 1 && kicked[0] === 30);
      restore();
    }

    if (prev === undefined) delete process.env.PROTRACTOR_NEW_SHOP_FASTPATH_DAYS;
    else process.env.PROTRACTOR_NEW_SHOP_FASTPATH_DAYS = prev;
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll protractor new-shop fastpath assertions passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
