/**
 * Regression smoke for Task #272 — Concern Assistant skip-learning is
 * now strictly shop-only.
 *
 * Run: `npx tsx tests/plan-build-task-272.smoke.ts`
 *
 * Locks in:
 *   1. `getSkipHints` reads ONLY the per-shop rollup. A question with a
 *      damning global skip rate but no per-shop history must NOT appear
 *      in the returned `avoid` list.
 *   2. A shop with its own history still gets that history surfaced.
 *   3. A null/missing shopId returns empty hints (no global fallback,
 *      no cross-shop bleed-through).
 *   4. `recordRoundResults` keeps writing the global rollup so the admin
 *      skip-stats view (Task #268) and any future analysis still work.
 */

import {
  getSkipHints,
  recordRoundResults,
} from "../lib/concernSkipLearning";
import { makeFakeDb } from "./utils/fake-mongo";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

async function main() {
  section("getSkipHints — ignores global rollup entirely (Task #272)");

  // Seed the collection by hand so we can give the global rollup a
  // damning skip rate (with multiple contributing shops, so it would
  // have surfaced under the pre-#272 quorum) while leaving the target
  // shop with no history at all.
  const fake = makeFakeDb({
    concern_question_stats: [
      {
        shopId: null,
        symptomCategory: "BRAKES",
        normalizedQuestion: "are any warning lights on",
        lastSampleText: "Are any warning lights on?",
        asked: 50,
        skipped: 45,
        contributingShopIds: ["1", "2", "3", "4"],
      },
      // A different shop has plenty of history but we're querying as
      // shop 9999, which has none.
      {
        shopId: "42",
        symptomCategory: "BRAKES",
        normalizedQuestion: "are any warning lights on",
        lastSampleText: "Are any warning lights on?",
        asked: 10,
        skipped: 9,
      },
    ],
  });

  const newShopHints = await getSkipHints({
    db: fake.db as any,
    shopId: 9999,
    symptomCategory: "BRAKES",
  });
  ok(
    "new shop with no history gets empty avoid (no global fallback)",
    newShopHints.avoid.length === 0,
  );
  ok(
    "new shop with no history gets empty prefer (no global fallback)",
    newShopHints.prefer.length === 0,
  );

  // Another shop's per-shop doc must not bleed across either.
  ok(
    "another shop's per-shop history does not leak to this shop",
    !newShopHints.avoid.some((a) => /warning lights/i.test(a.question)),
  );

  section("getSkipHints — own shop history still surfaces");
  const ownShopHints = await getSkipHints({
    db: fake.db as any,
    shopId: 42,
    symptomCategory: "BRAKES",
  });
  ok(
    "shop 42's own warn-light history surfaces in avoid",
    ownShopHints.avoid.some((a) => /warning lights/i.test(a.question)),
  );

  section("getSkipHints — null shopId returns empty");
  const nullHints = await getSkipHints({
    db: fake.db as any,
    shopId: null,
    symptomCategory: "BRAKES",
  });
  ok("null shopId yields empty avoid", nullHints.avoid.length === 0);
  ok("null shopId yields empty prefer", nullHints.prefer.length === 0);

  section("recordRoundResults — still writes the global rollup");
  const recFake = makeFakeDb({});
  await recordRoundResults({
    db: recFake.db as any,
    shopId: 7,
    symptomCategory: "BRAKES",
    results: [
      { question: "Does the brake pedal feel different?", answered: false },
    ],
  });
  const stats = recFake.collections["concern_question_stats"];
  const perShop = stats.find(
    (d) => d.shopId === "7" && d.normalizedQuestion === "does the brake pedal feel different",
  );
  const global = stats.find(
    (d) => d.shopId === null && d.normalizedQuestion === "does the brake pedal feel different",
  );
  ok("per-shop rollup written", !!perShop && perShop.asked === 1 && perShop.skipped === 1);
  ok(
    "global rollup also written (admin skip-stats view from #268 still works)",
    !!global && global.asked === 1 && global.skipped === 1,
  );
  ok(
    "global rollup still tracks contributing shops",
    Array.isArray(global?.contributingShopIds) &&
      global!.contributingShopIds.includes("7"),
  );

  if (failed === 0) {
    console.log(`\nAll checks passed.`);
    process.exit(0);
  } else {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
