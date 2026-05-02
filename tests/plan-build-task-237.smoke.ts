/**
 * Regression smoke for Task #237 — failed trial-conversion charges.
 *
 * Run: `npx tsx tests/plan-build-task-237.smoke.ts`
 *
 * Locks in:
 *   1. `isTrialConvertedSubscription` only matches the exact metadata
 *      `{ convertedFromTrial: "true" }` (Stripe metadata is case-sensitive
 *      strings) — keeps normal subs on the legacy 7-day grace path.
 *   2. `evaluateTrialConversionFailure` increments correctly, suspends at
 *      the Nth attempt, clamps a missing/zero/negative ceiling to a sane
 *      default (a 0 default would suspend on the first failure).
 *   3. Default ceiling is 3, matching `BillingSettings`.
 *   4. The new email helpers produce the right subject/copy/CTA and
 *      switch their pluralization on the boundary case.
 */

import {
  DEFAULT_TRIAL_CONVERSION_MAX_PAYMENT_RETRIES,
  evaluateTrialConversionFailure,
  isTrialConvertedSubscription,
} from "../lib/trial-conversion-billing";
import {
  makeTrialConversionPaymentFailedEmail,
  makeTrialConversionSuspendedEmail,
} from "../lib/email";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

function section(name: string) {
  console.log(`\n${name}`);
}

section("isTrialConvertedSubscription");
ok(
  "true for metadata.convertedFromTrial === 'true'",
  isTrialConvertedSubscription({ convertedFromTrial: "true", shopId: "42" }),
);
ok(
  "false for missing metadata",
  !isTrialConvertedSubscription(undefined) && !isTrialConvertedSubscription(null),
);
ok("false when flag is missing", !isTrialConvertedSubscription({ shopId: "42" }));
ok(
  "false when flag is the string 'false'",
  !isTrialConvertedSubscription({ convertedFromTrial: "false" }),
);
ok(
  "false when flag is uppercase",
  !isTrialConvertedSubscription({ convertedFromTrial: "TRUE" }),
);

section("evaluateTrialConversionFailure (default ceiling = 3)");
{
  const first = evaluateTrialConversionFailure(0, 3);
  ok("first failure: count=1", first.failureCount === 1);
  ok("first failure: isFirstFailure", first.isFirstFailure);
  ok("first failure: not suspending", !first.shouldSuspend);
  ok("first failure: 2 attempts remaining", first.attemptsRemaining === 2);

  const second = evaluateTrialConversionFailure(1, 3);
  ok("second failure: count=2", second.failureCount === 2);
  ok("second failure: not first", !second.isFirstFailure);
  ok("second failure: not suspending", !second.shouldSuspend);
  ok("second failure: 1 attempt remaining", second.attemptsRemaining === 1);

  const third = evaluateTrialConversionFailure(2, 3);
  ok("third failure: count=3", third.failureCount === 3);
  ok("third failure: SUSPENDS at the ceiling", third.shouldSuspend);
  ok("third failure: 0 remaining", third.attemptsRemaining === 0);
}

section("evaluateTrialConversionFailure (clamping)");
{
  const noPrev = evaluateTrialConversionFailure(undefined, 3);
  ok("undefined prevCount treated as 0", noPrev.failureCount === 1 && noPrev.isFirstFailure);

  const negativePrev = evaluateTrialConversionFailure(-5, 3);
  ok("negative prevCount clamped to 0", negativePrev.failureCount === 1);

  const fractionalPrev = evaluateTrialConversionFailure(1.7, 3);
  ok("fractional prevCount floored", fractionalPrev.failureCount === 2);

  const noMax = evaluateTrialConversionFailure(0, undefined);
  ok(
    "undefined maxRetries falls back to default",
    noMax.maxRetries === DEFAULT_TRIAL_CONVERSION_MAX_PAYMENT_RETRIES,
  );
  ok("default ceiling is 3", DEFAULT_TRIAL_CONVERSION_MAX_PAYMENT_RETRIES === 3);

  const zeroMax = evaluateTrialConversionFailure(0, 0);
  ok(
    "zero maxRetries falls back to default",
    zeroMax.maxRetries === DEFAULT_TRIAL_CONVERSION_MAX_PAYMENT_RETRIES,
  );

  const negMax = evaluateTrialConversionFailure(0, -2);
  ok("negative maxRetries clamped to >= 1", negMax.maxRetries >= 1);
}

section("evaluateTrialConversionFailure (custom ceiling = 5)");
{
  const r4 = evaluateTrialConversionFailure(3, 5);
  ok("4th of 5: still in budget", !r4.shouldSuspend && r4.attemptsRemaining === 1);
  const r5 = evaluateTrialConversionFailure(4, 5);
  ok("5th of 5: suspends", r5.shouldSuspend && r5.attemptsRemaining === 0);
}

section("makeTrialConversionPaymentFailedEmail");
{
  const url = "https://mos.tools/dashboard/settings/billing";
  const e2 = makeTrialConversionPaymentFailedEmail("Acme Auto", url, 2);
  ok(
    "subject mentions trial conversion + shop name",
    e2.subject.includes("Trial conversion") && e2.subject.includes("Acme Auto"),
    e2.subject,
  );
  ok("plural copy when 2 attempts remain", e2.text.includes("2 more times"), e2.text);
  ok("CTA URL present in HTML", e2.html.includes(url));
  ok("CTA URL present in text", e2.text.includes(url));

  const e1 = makeTrialConversionPaymentFailedEmail("Acme Auto", url, 1);
  ok("singular copy when 1 attempt remains", e1.text.includes("1 more time"), e1.text);

  const e0 = makeTrialConversionPaymentFailedEmail("Acme Auto", url, 0);
  ok(
    "last-attempt copy when 0 remain",
    e0.text.includes("last automatic retry"),
    e0.text,
  );
}

section("makeTrialConversionSuspendedEmail");
{
  const url = "https://mos.tools/dashboard/settings/billing";
  const owner = makeTrialConversionSuspendedEmail("Acme Auto", url, true);
  ok(
    "owner subject is URGENT and names the shop",
    owner.subject.includes("URGENT") && owner.subject.includes("Acme Auto"),
    owner.subject,
  );
  ok("owner CTA URL present", owner.html.includes(url) && owner.text.includes(url));

  const admin = makeTrialConversionSuspendedEmail("Acme Auto", url, false);
  ok(
    "admin subject is [Platform]-prefixed",
    admin.subject.startsWith("[Platform]"),
    admin.subject,
  );
  ok(
    "owner and admin variants are distinct",
    owner.subject !== admin.subject && owner.html !== admin.html,
  );
}

section("BillingSettings.trialConversionMaxPaymentRetries default");
{
  ok(
    "DEFAULT_TRIAL_CONVERSION_MAX_PAYMENT_RETRIES matches the BillingSettings default",
    DEFAULT_TRIAL_CONVERSION_MAX_PAYMENT_RETRIES === 3,
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll task-237 smoke checks passed");
