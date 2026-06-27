/**
 * Smoke test for `dedupeFollowUpQuestions` (Task #682).
 *
 * Run: `npx tsx tests/concern-dedupe-questions.smoke.ts`
 *
 * Locks in the hard "More Questions" dedup that both concern-assistant
 * routes (dashboard + extension) and both frontends (modal + extension
 * sidepanel) rely on. The model is only *softly* asked to avoid repeats, so
 * this filter is the real enforcement: it must drop questions already asked
 * in prior rounds, drop duplicates within the returned set, and catch
 * reworded / re-cased / re-punctuated near-duplicates.
 */

import {
  dedupeFollowUpQuestions,
  normalizeQuestion,
} from "../lib/concernSkipLearning";

let failed = 0;

function deepEq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} — got ${g}, want ${w}`);
  }
}

console.log("dedupeFollowUpQuestions");

// Exact repeats of already-asked questions are dropped.
deepEq(
  "drops exact already-asked question",
  dedupeFollowUpQuestions(
    ["Are any warning lights on?", "Is the brake pedal soft?"],
    ["Are any warning lights on?"],
  ),
  ["Is the brake pedal soft?"],
);

// Near-duplicates (casing / trailing punctuation / whitespace) are dropped.
deepEq(
  "drops near-duplicate (case + punctuation + spacing)",
  dedupeFollowUpQuestions(
    ["  are any   warning lights ON  "],
    ["Are any warning lights on?"],
  ),
  [],
);

// Numbered-list prefixes don't defeat the match.
deepEq(
  "drops re-ask carrying a numbering prefix",
  dedupeFollowUpQuestions(
    ["1. Are any warning lights on?"],
    ["Are any warning lights on?"],
  ),
  [],
);

// Duplicates within the returned set itself are collapsed (keeps first).
deepEq(
  "collapses duplicates inside the new set",
  dedupeFollowUpQuestions(
    [
      "How long has this been happening?",
      "how long has this been happening",
      "Does it happen when braking?",
    ],
    [],
  ),
  ["How long has this been happening?", "Does it happen when braking?"],
);

// All-duplicate set yields empty → caller shows "no further questions".
deepEq(
  "returns empty when nothing new remains",
  dedupeFollowUpQuestions(
    ["Are any warning lights on?", "Is the vehicle starting?"],
    ["Is the vehicle starting?", "Are any warning lights on?"],
  ),
  [],
);

// Genuinely new questions survive untouched and keep original wording.
deepEq(
  "keeps genuinely new questions with original wording",
  dedupeFollowUpQuestions(
    ["Does the noise change with speed?"],
    ["Are any warning lights on?"],
  ),
  ["Does the noise change with speed?"],
);

// Defensive: empty / nullish inputs never throw.
deepEq("handles empty new set", dedupeFollowUpQuestions([], ["x?"]), []);
deepEq(
  "handles empty asked set",
  dedupeFollowUpQuestions(["New question?"], []),
  ["New question?"],
);
deepEq(
  "ignores blank/whitespace entries",
  dedupeFollowUpQuestions(["   ", "Real question?"], []),
  ["Real question?"],
);

// Sanity: normalizeQuestion underpins the matching.
deepEq(
  "normalizeQuestion strips numbering + trailing punctuation + case",
  normalizeQuestion("2) Are any WARNING lights on?"),
  "are any warning lights on",
);

if (failed === 0) {
  console.log("\nAll concern dedupe checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} concern dedupe check(s) failed.`);
  process.exit(1);
}
