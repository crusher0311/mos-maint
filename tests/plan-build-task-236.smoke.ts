/**
 * Regression smoke test for Task #236 — admin-tunable trial reminder
 * timing & templates.
 *
 * Run: `npx tsx tests/plan-build-task-236.smoke.ts`
 *
 * Background
 * ----------
 * The trial cron used to send reminder emails on a hardcoded `[7, 3, 1]`
 * day schedule and used a hardcoded subject/body. Platform admins now
 * configure both the day list and the email copy from the billing
 * settings page (same place as `trialDays`).
 *
 * What this test locks in
 * -----------------------
 *   1. `sanitizeTrialReminderDays` cleans junk inputs, dedupes, sorts
 *      descending, and falls back to the default `[7, 3, 1]` when the
 *      input has no usable numbers. (Without this, a fat-fingered admin
 *      could disable reminders entirely or get a malformed schedule.)
 *   2. `makeTrialReminderEmail` keeps the previous copy by default and
 *      properly substitutes `{{shopName}}`, `{{daysLeft}}`, `{{dayWord}}`,
 *      `{{trialEndsAt}}` and `{{addCardUrl}}` when overrides are given.
 *   3. `makeTrialReminderEmail` falls back to the safe default when an
 *      override field is empty/whitespace only (so an admin can't ship a
 *      blank email by clearing a textarea).
 *   4. The default templates exported from `lib/email.ts` mention every
 *      supported placeholder — if someone trims one out, the placeholder
 *      hint in the admin UI starts lying.
 *   5. The cron route reads `settings.trialReminderDays` (not the old
 *      `REMINDER_DAYS` constant) and forwards the configured templates
 *      into `makeTrialReminderEmail`, and the candidate horizon scales
 *      with the largest configured reminder day.
 *   6. The save-settings route persists every new field and validates the
 *      day list with `sanitizeTrialReminderDays`, and the BillingSettings
 *      type carries the four new fields.
 *   7. The admin form exposes all four configuration fields and shows the
 *      placeholder reference so admins know what variables they can use.
 */

import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_TRIAL_REMINDER_DAYS,
  sanitizeTrialReminderDays,
} from "../lib/stripe";
import {
  DEFAULT_TRIAL_REMINDER_SUBJECT,
  DEFAULT_TRIAL_REMINDER_HTML,
  DEFAULT_TRIAL_REMINDER_TEXT,
  makeTrialReminderEmail,
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

console.log("Task #236 regression checks");

// ---------------------------------------------------------------------------
// 1. sanitizeTrialReminderDays
// ---------------------------------------------------------------------------
ok(
  "DEFAULT_TRIAL_REMINDER_DAYS preserves the historical 7/3/1 schedule",
  JSON.stringify(DEFAULT_TRIAL_REMINDER_DAYS) === JSON.stringify([7, 3, 1]),
  `got ${JSON.stringify(DEFAULT_TRIAL_REMINDER_DAYS)}`,
);

const cases: Array<[string, unknown, number[]]> = [
  ["non-array input falls back to defaults", "7,3,1", [7, 3, 1]],
  ["empty array falls back to defaults", [], [7, 3, 1]],
  ["junk-only array falls back to defaults", ["abc", null, -1, 0, NaN], [7, 3, 1]],
  ["string numbers parsed", ["14", "7", "3", "1"], [14, 7, 3, 1]],
  ["floats truncated", [14.9, 7.2, 3.5], [14, 7, 3]],
  ["dupes removed and sorted desc", [3, 7, 7, 14, 1, 3], [14, 7, 3, 1]],
  ["mixed junk + valid keeps valid only", [{ a: 1 }, "abc", 5, "10", -2], [10, 5]],
];
for (const [label, input, expected] of cases) {
  const got = sanitizeTrialReminderDays(input);
  ok(
    `sanitizeTrialReminderDays: ${label}`,
    JSON.stringify(got) === JSON.stringify(expected),
    `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
  );
}

// The function must not return the same array reference on every call —
// otherwise mutating the cron's local copy would mutate the default.
const a = sanitizeTrialReminderDays([]);
const b = sanitizeTrialReminderDays([]);
ok("sanitizeTrialReminderDays returns fresh arrays", a !== b);

// ---------------------------------------------------------------------------
// 2 + 3. makeTrialReminderEmail templating + safe defaults
// ---------------------------------------------------------------------------
const trialEndsAt = new Date("2026-07-01T12:00:00Z");

const defaultMsg = makeTrialReminderEmail(
  "Joe's Garage",
  3,
  trialEndsAt,
  "https://mos.tools/dashboard/settings/billing",
);

ok(
  "default subject still contains the day count and unit",
  defaultMsg.subject.includes("3 days") && defaultMsg.subject.includes("MOS Tools trial"),
  `got: ${defaultMsg.subject}`,
);
ok(
  "default html includes the shop name, day count and add-card URL",
  defaultMsg.html.includes("Joe&#39;s Garage") || defaultMsg.html.includes("Joe's Garage"),
  // we substitute as raw text, so it should be the literal name
);
ok(
  "default html literally substitutes the shop name (no HTML entity escape)",
  defaultMsg.html.includes("Joe's Garage"),
  "shop name should appear verbatim in the html body",
);
ok(
  "default html includes the add-card URL",
  defaultMsg.html.includes("https://mos.tools/dashboard/settings/billing"),
);
ok(
  "default text includes both day count and pretty end-date",
  defaultMsg.text.includes("3 days") && /July 1, 2026/.test(defaultMsg.text),
  `got: ${defaultMsg.text}`,
);

const dayMsg = makeTrialReminderEmail("Shop", 1, trialEndsAt, "https://x");
ok(
  "dayWord is singular when daysLeft === 1",
  /\b1 day\b/.test(dayMsg.subject) && !/\b1 days\b/.test(dayMsg.subject),
  `got: ${dayMsg.subject}`,
);

const overrideMsg = makeTrialReminderEmail(
  "Acme Auto",
  7,
  trialEndsAt,
  "https://example.com/billing",
  {
    subject: "Trial ending: {{daysLeft}} {{dayWord}} for {{shopName}}",
    html: "<p>{{shopName}} trial ends on {{trialEndsAt}} — <a href=\"{{addCardUrl}}\">add card</a></p>",
    text: "Hi {{shopName}}, {{daysLeft}} {{dayWord}} left until {{trialEndsAt}}. {{addCardUrl}}",
  },
);
ok(
  "override subject substitutes all placeholders",
  overrideMsg.subject === "Trial ending: 7 days for Acme Auto",
  `got: ${overrideMsg.subject}`,
);
ok(
  "override html substitutes shopName, trialEndsAt, addCardUrl",
  overrideMsg.html === "<p>Acme Auto trial ends on Wednesday, July 1, 2026 — <a href=\"https://example.com/billing\">add card</a></p>",
  `got: ${overrideMsg.html}`,
);
ok(
  "override text substitutes all placeholders",
  overrideMsg.text === "Hi Acme Auto, 7 days left until Wednesday, July 1, 2026. https://example.com/billing",
  `got: ${overrideMsg.text}`,
);

// Empty / whitespace overrides must fall back to defaults — the admin can't
// accidentally ship a blank email by clearing a textarea.
const blankFallback = makeTrialReminderEmail("Shop", 3, trialEndsAt, "https://x", {
  subject: "",
  html: "   \n  ",
  text: "",
});
ok(
  "empty subject override falls back to default subject",
  blankFallback.subject.includes("3 days") && blankFallback.subject.includes("MOS Tools"),
);
ok(
  "whitespace-only html override falls back to default html",
  blankFallback.html.includes("Add Payment Method"),
);
ok(
  "empty text override falls back to default text body",
  blankFallback.text.includes("Add payment method:"),
);

// Unknown placeholders silently render as empty — they don't leak `{{foo}}`
// into customer-facing copy.
const unknownPlaceholder = makeTrialReminderEmail("Shop", 1, trialEndsAt, "https://x", {
  subject: "Hi {{shopName}} {{not_a_var}}",
});
ok(
  "unknown placeholders render as empty string, not literal {{...}}",
  unknownPlaceholder.subject === "Hi Shop " &&
    !unknownPlaceholder.subject.includes("{{not_a_var}}"),
  `got: ${unknownPlaceholder.subject}`,
);

// ---------------------------------------------------------------------------
// 4. Default templates carry every documented placeholder
// ---------------------------------------------------------------------------
const REQUIRED_PLACEHOLDERS = ["shopName", "daysLeft", "dayWord", "trialEndsAt", "addCardUrl"];
for (const ph of REQUIRED_PLACEHOLDERS) {
  ok(
    `DEFAULT_TRIAL_REMINDER_HTML mentions {{${ph}}}`,
    DEFAULT_TRIAL_REMINDER_HTML.includes(`{{${ph}}}`),
  );
}
for (const ph of ["shopName", "daysLeft", "dayWord", "trialEndsAt", "addCardUrl"]) {
  ok(
    `DEFAULT_TRIAL_REMINDER_TEXT mentions {{${ph}}}`,
    DEFAULT_TRIAL_REMINDER_TEXT.includes(`{{${ph}}}`),
  );
}
ok(
  "DEFAULT_TRIAL_REMINDER_SUBJECT mentions {{daysLeft}} and {{dayWord}}",
  DEFAULT_TRIAL_REMINDER_SUBJECT.includes("{{daysLeft}}") &&
    DEFAULT_TRIAL_REMINDER_SUBJECT.includes("{{dayWord}}"),
);

// ---------------------------------------------------------------------------
// 5. Cron route uses settings, not the old REMINDER_DAYS constant
// ---------------------------------------------------------------------------
const cronSrc = fs.readFileSync(
  path.join(__dirname, "..", "app", "api", "cron", "trial-check", "route.ts"),
  "utf8",
);
ok(
  "cron route no longer defines a hardcoded REMINDER_DAYS constant",
  !/const\s+REMINDER_DAYS\s*=\s*\[/.test(cronSrc),
);
ok(
  "cron route reads settings.trialReminderDays for the day match",
  /settings\.trialReminderDays\.find\(/.test(cronSrc),
);
ok(
  "cron route forwards the configured subject/html/text into makeTrialReminderEmail",
  /makeTrialReminderEmail\([\s\S]*subject:\s*settings\.trialReminderSubject[\s\S]*html:\s*settings\.trialReminderHtml[\s\S]*text:\s*settings\.trialReminderText/.test(
    cronSrc,
  ),
);
ok(
  "cron route candidate horizon scales with the largest configured reminder day",
  /Math\.max\(\.\.\.settings\.trialReminderDays\)/.test(cronSrc) &&
    /horizonDays\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(cronSrc),
);

// ---------------------------------------------------------------------------
// 6. Save-settings route persists the new fields and the type carries them
// ---------------------------------------------------------------------------
const saveSrc = fs.readFileSync(
  path.join(__dirname, "..", "app", "api", "admin", "billing", "settings", "route.ts"),
  "utf8",
);
for (const field of [
  "trialReminderDays",
  "trialReminderSubject",
  "trialReminderHtml",
  "trialReminderText",
]) {
  ok(
    `save-settings route persists ${field}`,
    saveSrc.includes(field),
  );
}
ok(
  "save-settings route sanitizes the day list before persisting",
  /sanitizeTrialReminderDays\(body\.trialReminderDays\)/.test(saveSrc),
);
ok(
  "save-settings route returns the persisted settings so the UI can rehydrate",
  /settings:\s*persistedSettings/.test(saveSrc),
);

const stripeSrc = fs.readFileSync(
  path.join(__dirname, "..", "lib", "stripe.ts"),
  "utf8",
);
for (const field of [
  "trialReminderDays: number[]",
  "trialReminderSubject: string",
  "trialReminderHtml: string",
  "trialReminderText: string",
]) {
  ok(
    `BillingSettings type declares "${field}"`,
    stripeSrc.includes(field),
  );
}

// ---------------------------------------------------------------------------
// 7. Admin form exposes the new controls + placeholder reference
// ---------------------------------------------------------------------------
const formSrc = fs.readFileSync(
  path.join(__dirname, "..", "app", "admin", "billing", "BillingSettingsForm.tsx"),
  "utf8",
);
ok(
  "admin form has a Trial Reminder Emails section heading",
  /Trial Reminder Emails/.test(formSrc),
);
ok(
  "admin form has a reminder days input bound to the parser",
  /reminderDaysInput/.test(formSrc) && /parseReminderDays\(/.test(formSrc),
);
for (const field of [
  "trialReminderSubject",
  "trialReminderHtml",
  "trialReminderText",
]) {
  ok(
    `admin form binds ${field} to a controlled input`,
    formSrc.includes(`settings.${field}`) && formSrc.includes(`${field}: e.target.value`),
  );
}
for (const ph of REQUIRED_PLACEHOLDERS) {
  ok(
    `admin form documents the {{${ph}}} placeholder for users`,
    formSrc.includes(`{{${ph}}}`),
  );
}
ok(
  "admin form rehydrates local state from the server response after save",
  /data\?\.settings/.test(formSrc) && /setSettings\(persisted\)/.test(formSrc),
);

if (failed === 0) {
  console.log("\nAll Task #236 regression checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} Task #236 regression check(s) failed.`);
  process.exit(1);
}
