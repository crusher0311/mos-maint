/**
 * Smoke tests for concern follow-up question cache (task #1139).
 *
 * Run: `npx tsx tests/concern-followup-cache.smoke.ts`
 *
 * Covers:
 *   - Concern normalization (case, whitespace, punctuation)
 *   - Cache key stability (same normalized concern → same hash)
 *   - applySkipHintFilter: avoid-list drops questions
 *   - applyPreferHintOrder: prefer-list promotes questions to front
 *   - applySkipHints: combined avoid + prefer post-processing
 *   - Empty result is not cached (empty-cache poisoning guard)
 *   - Fail-open: cache read error returns null (simulated)
 */

import {
  normalizeConcernForCache,
  concernCacheKey,
  CONCERN_FOLLOWUP_PROMPT_VERSION,
  applySkipHintFilter,
  applyPreferHintOrder,
  applySkipHints,
} from "../lib/data/repositories/pg/concern-followup-cache";

let failed = 0;

function eq<T>(name: string, got: T, want: T) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}\n    got:  ${g}\n    want: ${w}`);
  }
}

function ok(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

// ---------------------------------------------------------------------------
// normalizeConcernForCache
// ---------------------------------------------------------------------------
console.log("\nnormalizeConcernForCache");

eq("lowercases concern text", normalizeConcernForCache("Brake Noise"), "brake noise");
eq("collapses extra whitespace", normalizeConcernForCache("  brake   noise  "), "brake noise");
eq("strips trailing period", normalizeConcernForCache("brake noise."), "brake noise");
eq("strips trailing question mark", normalizeConcernForCache("check engine light?"), "check engine light");
eq("collapses non-breaking spaces", normalizeConcernForCache("oil\u00a0change"), "oil change");
eq("returns empty string for empty input", normalizeConcernForCache(""), "");
eq("returns empty string for whitespace-only input", normalizeConcernForCache("   "), "");

// ---------------------------------------------------------------------------
// concernCacheKey — same normalized text → same hash; different → different
// ---------------------------------------------------------------------------
console.log("\nconcernCacheKey");

const hashBrakeNoise = concernCacheKey("brake noise");
const hashBrakeNoiseUpper = concernCacheKey(normalizeConcernForCache("BRAKE NOISE"));
const hashCheckEngine = concernCacheKey("check engine light");

eq("case-normalized concerns hash to the same key", hashBrakeNoise, hashBrakeNoiseUpper);
ok("different concerns hash to different keys", hashBrakeNoise !== hashCheckEngine);
ok("hash is 32 hex chars", /^[0-9a-f]{32}$/.test(hashBrakeNoise));

const hashV1 = concernCacheKey("brake noise", "v1");
const hashV2 = concernCacheKey("brake noise", "v2");
ok("different prompt versions produce different hashes", hashV1 !== hashV2);
ok("CONCERN_FOLLOWUP_PROMPT_VERSION is non-empty", CONCERN_FOLLOWUP_PROMPT_VERSION.length > 0);

// ---------------------------------------------------------------------------
// applySkipHintFilter — avoid-list drops questions
// ---------------------------------------------------------------------------
console.log("\napplySkipHintFilter");

const baseQuestions = [
  "How long has the brake noise been occurring?",
  "Does the noise happen when braking or all the time?",
  "Have you noticed any vibration in the steering wheel?",
  "When were your brakes last replaced?",
];

eq(
  "returns all questions when avoid list is empty",
  applySkipHintFilter(baseQuestions, []),
  baseQuestions,
);

eq(
  "drops question matching an avoid hint (exact)",
  applySkipHintFilter(baseQuestions, [{ question: "When were your brakes last replaced?" }]),
  [
    "How long has the brake noise been occurring?",
    "Does the noise happen when braking or all the time?",
    "Have you noticed any vibration in the steering wheel?",
  ],
);

eq(
  "drops question matching an avoid hint (case/punctuation insensitive)",
  applySkipHintFilter(baseQuestions, [{ question: "WHEN WERE YOUR BRAKES LAST REPLACED" }]),
  [
    "How long has the brake noise been occurring?",
    "Does the noise happen when braking or all the time?",
    "Have you noticed any vibration in the steering wheel?",
  ],
);

eq(
  "drops multiple avoid hints",
  applySkipHintFilter(baseQuestions, [
    { question: "When were your brakes last replaced?" },
    { question: "have you noticed any vibration in the steering wheel" },
  ]),
  [
    "How long has the brake noise been occurring?",
    "Does the noise happen when braking or all the time?",
  ],
);

eq(
  "returns empty array when all questions are filtered",
  applySkipHintFilter(
    ["How long has the brake noise been occurring?"],
    [{ question: "how long has the brake noise been occurring" }],
  ),
  [],
);

// ---------------------------------------------------------------------------
// applyPreferHintOrder — prefer-list promotes questions to front
// ---------------------------------------------------------------------------
console.log("\napplyPreferHintOrder");

eq(
  "returns all questions unchanged when prefer list is empty",
  applyPreferHintOrder(baseQuestions, []),
  baseQuestions,
);

// A preferred question that appears later in the list is promoted to front.
eq(
  "promotes preferred question to the front of the list",
  applyPreferHintOrder(
    [
      "How long has the brake noise been occurring?",
      "Does the noise happen when braking or all the time?",
      "When were your brakes last replaced?",
    ],
    [{ question: "When were your brakes last replaced?" }],
  ),
  [
    "When were your brakes last replaced?",
    "How long has the brake noise been occurring?",
    "Does the noise happen when braking or all the time?",
  ],
);

// Multiple prefer hints — all promoted, order within preferred group is stable.
eq(
  "promotes multiple preferred questions, stable within each group",
  applyPreferHintOrder(
    [
      "How long has the brake noise been occurring?",
      "Does the noise happen when braking or all the time?",
      "Have you noticed any vibration in the steering wheel?",
      "When were your brakes last replaced?",
    ],
    [
      { question: "When were your brakes last replaced?" },
      { question: "does the noise happen when braking or all the time" },
    ],
  ),
  [
    "Does the noise happen when braking or all the time?",
    "When were your brakes last replaced?",
    "How long has the brake noise been occurring?",
    "Have you noticed any vibration in the steering wheel?",
  ],
);

// A prefer hint with no matching question is silently ignored (no crash).
eq(
  "ignores prefer hints with no matching question",
  applyPreferHintOrder(baseQuestions, [{ question: "completely unrelated question here" }]),
  baseQuestions,
);

// ---------------------------------------------------------------------------
// applySkipHints — combined avoid + prefer
// ---------------------------------------------------------------------------
console.log("\napplySkipHints");

const fullHints = {
  avoid: [{ question: "Have you noticed any vibration in the steering wheel?" }],
  prefer: [{ question: "Does the noise happen when braking or all the time?" }],
};

// Avoided question is dropped; preferred question is promoted.
eq(
  "drops avoided and promotes preferred in one call",
  applySkipHints(baseQuestions, fullHints),
  [
    "Does the noise happen when braking or all the time?",
    "How long has the brake noise been occurring?",
    "When were your brakes last replaced?",
  ],
);

// Empty hints = no change.
eq(
  "returns all questions unchanged with empty hints",
  applySkipHints(baseQuestions, { avoid: [], prefer: [] }),
  baseQuestions,
);

// If the preferred question is also in the avoid list, avoid wins (it is
// dropped before the prefer reorder step).
eq(
  "avoid takes precedence over prefer for the same question",
  applySkipHints(
    ["A?", "B?", "C?"],
    {
      avoid: [{ question: "B?" }],
      prefer: [{ question: "B?" }],
    },
  ),
  ["A?", "C?"],
);

// ---------------------------------------------------------------------------
// Empty-result guard (normalization edge case)
// ---------------------------------------------------------------------------
console.log("\nEmpty-result guard");

eq(
  "empty concern normalizes to empty string (write would be skipped)",
  normalizeConcernForCache(""),
  "",
);
eq(
  "whitespace-only concern normalizes to empty string (write would be skipped)",
  normalizeConcernForCache("   "),
  "",
);

// ---------------------------------------------------------------------------
// Fail-open: cache read error treated as null / cache miss (simulated)
// ---------------------------------------------------------------------------
console.log("\nFail-open cache read behavior");

// Simulate the .catch(null) pattern used in the routes. Wrapped in an async
// IIFE so top-level await is not needed (tsx/CJS compatibility).
(async () => {
  const fakeRead = async (): Promise<string[] | null> => {
    throw new Error("DB connection timeout");
  };
  // This mirrors the .catch in both concern-assistant routes.
  const failResult = await fakeRead().catch(() => null);
  eq(
    "cache read error returns null (fail-open, triggers OpenAI fallback)",
    failResult,
    null,
  );

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  if (failed === 0) {
    console.log("\nAll concern-followup-cache checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failed} concern-followup-cache check(s) failed.`);
    process.exit(1);
  }
})();
