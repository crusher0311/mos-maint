/**
 * Smoke test for the chunk-speed alert email HTML builders + lint.
 *
 * Run: `npx tsx tests/chunk-speed-email-html.smoke.ts`
 *
 * Sister to `backfill-chunk-speed-health.route.smoke.ts` (route-level)
 * and `backfill-chunk-speed-health.smoke.ts` (threshold/dedup logic).
 * This file covers the pure HTML builders extracted into `./email-html`
 * so a regression in the markup itself can be caught without spinning
 * up the route handler. The `lintEmailHtml` checks here lock in the
 * "missing closing tag / unsafe attribute" detector that backs the
 * preview script.
 */

import { SlowShop } from "../app/api/cron/backfill-chunk-speed-health/lib";
import {
  buildAlertEmailHtml,
  buildAlertEmailSubject,
  buildRecoveryEmailHtml,
  buildRecoveryEmailSubject,
  lintEmailHtml,
} from "../app/api/cron/backfill-chunk-speed-health/email-html";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeShop(overrides: Partial<SlowShop> & { reasons: string[] }): SlowShop {
  const base: SlowShop = {
    provider: "tekmetric",
    providerLabel: "Tekmetric",
    shopId: 42,
    name: "Acme Auto",
    reasons: overrides.reasons,
    reasonsKey: [...overrides.reasons].sort().join(","),
    rollup: {
      chunkSampleCount: 25,
      p95DurationMs: 12 * 60 * 1000,
      avgBackoff429Ms: 1000,
      jobsCacheHitRate: 0.9,
      jobsCacheTotal: 800,
      vehiclesCacheHitRate: 0.9,
      vehiclesCacheTotal: 600,
      customersCacheHitRate: 0.9,
      customersCacheTotal: 400,
    },
    p95Baseline: null,
  };
  return { ...base, ...overrides, rollup: { ...base.rollup, ...(overrides.rollup ?? {}) } };
}

console.log("chunk-speed-email-html smoke");

// (1) Alert builder: subject + payload contain the documented substrings.
{
  const html = buildAlertEmailHtml({
    rows: [{ shop: makeShop({ reasons: ["slow_p95"] }), isNew: true }],
    breachingTotal: 1,
    syncHealthUrl: "https://mos/sync-health",
  });
  ok("alert subject names breach count", buildAlertEmailSubject(1, 1).includes("1 shop(s) breaching (1 total)"));
  ok("alert html includes shop name", html.includes("Acme Auto"));
  ok("alert html includes MOS id cell", html.includes(">42<"));
  ok("alert html includes reason", html.includes("slow_p95"));
  ok("alert html flags NEW", html.includes("NEW"));
  ok("alert html links to sync-health url", html.includes("https://mos/sync-health"));
  ok("alert html escapes a special-char shop name", buildAlertEmailHtml({
    rows: [{ shop: makeShop({ name: "Down & Out <Garage>", reasons: ["slow_p95"] }), isNew: true }],
    breachingTotal: 1,
    syncHealthUrl: "https://mos/sync-health",
  }).includes("Down &amp; Out &lt;Garage&gt;"));
}

// (2) Alert builder: REASONS CHANGED badge fires when isNew=false.
{
  const html = buildAlertEmailHtml({
    rows: [{ shop: makeShop({ reasons: ["slow_p95", "high_backoff"] }), isNew: false }],
    breachingTotal: 1,
    syncHealthUrl: "https://mos/sync-health",
  });
  ok("alert html flags REASONS CHANGED for re-pages", html.includes("REASONS CHANGED"));
}

// (3) Alert builder: baseline regression cell shows "Nx baseline".
{
  const html = buildAlertEmailHtml({
    rows: [
      {
        shop: makeShop({
          reasons: ["regressed_p95"],
          p95Baseline: 60_000,
          rollup: {
            chunkSampleCount: 20,
            p95DurationMs: 4 * 60 * 1000,
            avgBackoff429Ms: 0,
            jobsCacheHitRate: 0.95,
            jobsCacheTotal: 800,
            vehiclesCacheHitRate: 0.93,
            vehiclesCacheTotal: 600,
            customersCacheHitRate: 0.91,
            customersCacheTotal: 400,
          },
        }),
        isNew: true,
      },
    ],
    breachingTotal: 1,
    syncHealthUrl: "https://mos/sync-health",
  });
  ok("alert html shows multiplier vs baseline", html.includes("× baseline"));
}

// (4) Recovery builder: subject + payload contain the documented bits.
{
  const subject = buildRecoveryEmailSubject("Acme Auto");
  const html = buildRecoveryEmailHtml({
    shopId: 42,
    name: "Acme Auto",
    lastSeenP95Ms: 12 * 60 * 1000,
    lastSeenAt: new Date("2026-04-27T14:30:00Z"),
    previousReasons: ["slow_p95", "high_backoff"],
    transition: "auto_clear",
    syncHealthUrl: "https://mos/sync-health",
  });
  ok("recovery subject names recovered shop", subject.includes("recovered") && subject.includes("Acme Auto"));
  ok("recovery html mentions dropped under threshold", html.includes("dropped back under"));
  ok("recovery html includes MOS shop id", html.includes("MOS shop 42"));
  ok("recovery html mentions auto-clear", html.includes("dedup row has been cleared"));
  ok("recovery html mentions other prior reasons in auto-clear", html.includes("high_backoff"));
}

// (5) Recovery builder: partial recovery wording differs from auto-clear.
{
  const html = buildRecoveryEmailHtml({
    shopId: 88,
    name: "Big Wrench",
    lastSeenP95Ms: 13 * 60 * 1000,
    lastSeenAt: new Date("2026-04-27T15:00:00Z"),
    previousReasons: ["slow_p95", "high_backoff"],
    transition: "reasons_changed",
    syncHealthUrl: "https://mos/sync-health",
  });
  ok("recovery (partial) html flags other reasons still active", html.includes("Other reasons still active"));
  ok("recovery (partial) html does NOT say dedup row cleared", !html.includes("dedup row has been cleared"));
}

// (6) Lint: clean markup → no issues.
{
  const issues = lintEmailHtml(buildAlertEmailHtml({
    rows: [{ shop: makeShop({ reasons: ["slow_p95"] }), isNew: true }],
    breachingTotal: 1,
    syncHealthUrl: "https://mos/sync-health",
  }));
  ok("lint: clean alert html → no issues", issues.length === 0, JSON.stringify(issues));

  const recoveryIssues = lintEmailHtml(buildRecoveryEmailHtml({
    shopId: 42,
    name: "Acme Auto",
    lastSeenP95Ms: 12 * 60 * 1000,
    lastSeenAt: new Date("2026-04-27T14:30:00Z"),
    previousReasons: ["slow_p95"],
    transition: "auto_clear",
    syncHealthUrl: "https://mos/sync-health",
  }));
  ok("lint: clean recovery html → no issues", recoveryIssues.length === 0, JSON.stringify(recoveryIssues));
}

// (7) Lint: missing closing tag → reports unclosed.
{
  const issues = lintEmailHtml(`<div><p>hello</div>`);
  ok(
    "lint: catches unclosed <p>",
    issues.some((i) => i.severity === "error" && /Unclosed <p>/.test(i.message)),
    JSON.stringify(issues),
  );
}

// (8) Lint: stray closing tag → reports stray.
{
  const issues = lintEmailHtml(`<div>hi</p></div>`);
  ok(
    "lint: catches stray </p>",
    issues.some((i) => i.severity === "error" && /Closing <\/p>/.test(i.message)),
    JSON.stringify(issues),
  );
}

// (9) Lint: tag never closed → reports it.
{
  const issues = lintEmailHtml(`<div><table><tr><td>x</td></tr>`);
  ok(
    "lint: flags tags that were never closed",
    issues.some((i) => i.severity === "error" && /never closed/.test(i.message)),
    JSON.stringify(issues),
  );
}

// (10) Lint: void elements (br, img, hr) don't trip the balance check.
{
  const issues = lintEmailHtml(`<div>line<br>line<hr><img src="x"></div>`);
  ok("lint: void elements ignored", issues.length === 0, JSON.stringify(issues));
}

// (11) Lint: unsafe inline event handler.
{
  const issues = lintEmailHtml(`<div><a href="x" onclick="alert(1)">click</a></div>`);
  ok(
    "lint: catches onclick handler",
    issues.some((i) => i.severity === "error" && /onclick/.test(i.message)),
    JSON.stringify(issues),
  );
}

// (12) Lint: unsafe javascript: url.
{
  const issues = lintEmailHtml(`<div><a href="javascript:alert(1)">x</a></div>`);
  ok(
    "lint: catches javascript: URL",
    issues.some((i) => i.severity === "error" && /javascript:/.test(i.message)),
    JSON.stringify(issues),
  );
}

// (13) Lint: malformed inline style declaration.
{
  const issues = lintEmailHtml(`<div style="color red;padding:6px">hi</div>`);
  ok(
    "lint: warns on style declaration without colon",
    issues.some((i) => i.severity === "warn" && /without a colon/.test(i.message)),
    JSON.stringify(issues),
  );
}

// (14) Lint: empty style value.
{
  const issues = lintEmailHtml(`<div style="color:;padding:6px">hi</div>`);
  ok(
    "lint: warns on empty style value",
    issues.some((i) => i.severity === "warn" && /no value/.test(i.message)),
    JSON.stringify(issues),
  );
}

// (15) Lint: too-wide width is flagged.
{
  const issues = lintEmailHtml(`<table style="width:900px"><tr><td>hi</td></tr></table>`);
  ok(
    "lint: warns when width exceeds 700px",
    issues.some((i) => i.severity === "warn" && /exceeds 700px/.test(i.message)),
    JSON.stringify(issues),
  );
}

// ---------------------------------------------------------------

if (failed > 0) {
  console.error(`\nFAILED: ${failed} check(s) did not pass.`);
  process.exit(1);
}
console.log(`\nAll chunk-speed email-html smoke checks passed.`);
