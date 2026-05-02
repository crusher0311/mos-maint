/**
 * Regression smoke for Task #264 — Concern Assistant learns from skipped
 * follow-up questions.
 *
 * Run: `npx tsx tests/plan-build-task-264.smoke.ts`
 *
 * Locks in:
 *   1. `normalizeQuestion` collapses whitespace, strips numbering and
 *      trailing punctuation so trivial wording differences don't fragment
 *      stats.
 *   2. `inferSymptomCategory` routes common phrases to the right bucket
 *      and falls back to `GENERAL`.
 *   3. `recordRoundResults` upserts both per-shop and global rollups,
 *      incrementing `asked` / `skipped` / `answered`.
 *   4. `getSkipHints` only surfaces `avoid` once a question crosses the
 *      `MIN_ASKED_FOR_HIGH_SKIP` guardrail, and falls back to the global
 *      rollup when the per-shop history is empty.
 *   5. `biasSymptomGuide` drops guide bullets whose normalized form
 *      matches the high-skip list while leaving headers and other lines
 *      intact.
 *   6. `renderHintsForPrompt` returns "" when there are no hints so it
 *      can be spliced into prompts unconditionally.
 */

import {
  HIGH_SKIP_RATE,
  MIN_ASKED_FOR_HIGH_SKIP,
  MIN_DISTINCT_SHOPS_FOR_GLOBAL_SKIP,
  biasSymptomGuide,
  getSkipHints,
  inferSymptomCategory,
  normalizeQuestion,
  recordRoundResults,
  renderHintsForPrompt,
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
  section("normalizeQuestion");
  ok(
    "lowercases, trims, strips trailing ?",
    normalizeQuestion("  Are any warning lights on?  ") === "are any warning lights on",
  );
  ok(
    "strips leading numbering",
    normalizeQuestion("1. How long has the noise been there?") === "how long has the noise been there",
  );
  ok(
    "strips dash bullet and collapses whitespace",
    normalizeQuestion("-   How   long  has  the  noise  been  there?") === "how long has the noise been there",
  );
  ok("empty in → empty out", normalizeQuestion("") === "");

  section("inferSymptomCategory");
  ok("brakes", inferSymptomCategory("Squealing brake noise in the morning") === "BRAKES");
  ok("CEL", inferSymptomCategory("Check engine light came on yesterday") === "CHECK ENGINE LIGHT");
  ok("AC", inferSymptomCategory("AC blowing warm air") === "AIR CONDITIONING");
  ok("battery", inferSymptomCategory("Car will not start, dead battery suspect") === "BATTERY / ALTERNATOR");
  ok("fallback", inferSymptomCategory("Need oil change soon") === "GENERAL");

  section("recordRoundResults");
  const fake = makeFakeDb({});
  // Shop 42, BRAKES — ask the same normalized question 3 times, with
  // 2 of the 3 left blank.
  for (let i = 0; i < 3; i++) {
    await recordRoundResults({
      db: fake.db as any,
      shopId: 42,
      symptomCategory: "BRAKES",
      results: [
        { question: "Are any warning lights on?", answered: i === 0 },
        { question: "How long has the noise been there?", answered: true },
      ],
    });
  }
  const stats = fake.collections["concern_question_stats"];
  ok("writes per-shop + global rows for both questions", stats.length === 4);

  const shopWarn = stats.find(
    (d) => d.shopId === "42" && d.normalizedQuestion === "are any warning lights on",
  );
  ok("warn-light row exists per-shop", !!shopWarn);
  ok("warn-light asked=3", shopWarn?.asked === 3);
  ok("warn-light skipped=2", shopWarn?.skipped === 2);

  const globalWarn = stats.find(
    (d) => d.shopId === null && d.normalizedQuestion === "are any warning lights on",
  );
  ok("warn-light row also written to global rollup", !!globalWarn && globalWarn.asked === 3);

  const shopNoise = stats.find(
    (d) => d.shopId === "42" && d.normalizedQuestion === "how long has the noise been there",
  );
  ok("noise-history row asked=3 skipped=0", shopNoise?.asked === 3 && shopNoise?.skipped === 0);

  section("getSkipHints — guardrail + ranking");
  const hints42 = await getSkipHints({
    db: fake.db as any,
    shopId: 42,
    symptomCategory: "BRAKES",
  });
  ok(
    "warn-light surfaces in `avoid` (skipped 2/3 ≥ HIGH_SKIP_RATE)",
    hints42.avoid.some((a) => /warning lights/i.test(a.question)) && 2 / 3 >= HIGH_SKIP_RATE,
  );
  ok(
    "noise-history surfaces in `prefer` (answered 3/3)",
    hints42.prefer.some((p) => /noise/i.test(p.question)),
  );
  ok(
    "below-threshold question is ignored",
    (await (async () => {
      // Only asked twice — under MIN_ASKED_FOR_HIGH_SKIP=3 — so should NOT surface.
      await recordRoundResults({
        db: fake.db as any,
        shopId: 42,
        symptomCategory: "BRAKES",
        results: [
          { question: "Does the brake pedal feel different?", answered: false },
          { question: "Does the brake pedal feel different?", answered: false },
        ],
      });
      const h = await getSkipHints({
        db: fake.db as any,
        shopId: 42,
        symptomCategory: "BRAKES",
      });
      return !h.avoid.some((a) => /pedal feel different/i.test(a.question));
    })()),
    `MIN_ASKED_FOR_HIGH_SKIP=${MIN_ASKED_FOR_HIGH_SKIP}`,
  );

  section("getSkipHints — global fallback for new shop");
  // Shop 42 is the only shop that's contributed so far, so the global
  // rollup for the warn-light question only has one distinct contributing
  // shop. Per Task #269, the global avoid should NOT surface to other
  // shops yet — that would let one outlier shop poison the global list.
  const newShopHintsSingleShop = await getSkipHints({
    db: fake.db as any,
    shopId: 9999,
    symptomCategory: "BRAKES",
  });
  ok(
    "single-shop global skip does NOT surface to other shops (Task #269 guardrail)",
    !newShopHintsSingleShop.avoid.some((a) => /warning lights/i.test(a.question)),
    `MIN_DISTINCT_SHOPS_FOR_GLOBAL_SKIP=${MIN_DISTINCT_SHOPS_FOR_GLOBAL_SKIP}`,
  );

  // Now have a second shop also skip the same warn-light question. With
  // two distinct contributing shops, the global avoid SHOULD surface.
  for (let i = 0; i < 3; i++) {
    await recordRoundResults({
      db: fake.db as any,
      shopId: 77,
      symptomCategory: "BRAKES",
      results: [{ question: "Are any warning lights on?", answered: false }],
    });
  }
  const globalWarnDoc = stats.find(
    (d) => d.shopId === null && d.normalizedQuestion === "are any warning lights on",
  );
  ok(
    "global rollup tracks distinct contributing shops",
    Array.isArray(globalWarnDoc?.contributingShopIds) &&
      globalWarnDoc!.contributingShopIds.length === 2 &&
      globalWarnDoc!.contributingShopIds.includes("42") &&
      globalWarnDoc!.contributingShopIds.includes("77"),
  );

  const newShopHintsTwoShops = await getSkipHints({
    db: fake.db as any,
    shopId: 9999,
    symptomCategory: "BRAKES",
  });
  ok(
    "global avoid surfaces to other shops once ≥2 distinct shops have skipped it",
    newShopHintsTwoShops.avoid.some((a) => /warning lights/i.test(a.question)),
  );

  // Per-shop behavior must be unchanged: shop 42's own avoid list still
  // shows the warn-light question even though only 42 has skipped it,
  // because per-shop entries don't need cross-shop quorum.
  const hints42AfterSecondShop = await getSkipHints({
    db: fake.db as any,
    shopId: 42,
    symptomCategory: "BRAKES",
  });
  ok(
    "per-shop avoid is unchanged by the global quorum guardrail",
    hints42AfterSecondShop.avoid.some((a) => /warning lights/i.test(a.question)),
  );

  // Legacy global rollup docs written before Task #269 won't have a
  // `contributingShopIds` array. They should be grandfathered in so the
  // new guardrail doesn't retroactively suppress hints that were already
  // in production use.
  const legacyFake = makeFakeDb({
    concern_question_stats: [
      {
        shopId: null,
        symptomCategory: "BRAKES",
        normalizedQuestion: "is the noise louder when braking",
        lastSampleText: "Is the noise louder when braking?",
        asked: 10,
        skipped: 8,
        // No contributingShopIds field — pre-Task-#269 doc.
      },
    ],
  });
  const legacyHints = await getSkipHints({
    db: legacyFake.db as any,
    shopId: 12345,
    symptomCategory: "BRAKES",
  });
  ok(
    "legacy global docs (no contributingShopIds field) are grandfathered into avoid",
    legacyHints.avoid.some((a) => /louder when braking/i.test(a.question)),
  );

  section("biasSymptomGuide");
  const guide = `BRAKES:
- Tell me the story about your brakes. What is happening?
- Are any warning lights on?
- Does the brake pedal feel different (e.g., soft, hard, or pulsating)?`;
  const biased = biasSymptomGuide(guide, hints42.avoid);
  ok("drops the warn-light bullet", !/Are any warning lights on\?/.test(biased));
  ok("keeps the brake-story bullet", /Tell me the story about your brakes/.test(biased));
  ok("keeps the BRAKES header", /^BRAKES:/m.test(biased));

  section("renderHintsForPrompt");
  ok(
    "empty hints render to empty string",
    renderHintsForPrompt({ avoid: [], prefer: [] }) === "",
  );
  const block = renderHintsForPrompt(hints42);
  ok("renders avoid header", /Avoid asking these/.test(block));
  ok("renders prefer header", /Prefer the style/.test(block));

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
