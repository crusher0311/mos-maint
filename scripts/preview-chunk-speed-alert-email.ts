/**
 * Render the chunk-speed alert + recovery email HTML to disk so on-call
 * (or anyone working on the alert markup) can eyeball the layout in a
 * real browser without sending an actual email.
 *
 * Usage:
 *   npx tsx scripts/preview-chunk-speed-alert-email.ts
 *   npx tsx scripts/preview-chunk-speed-alert-email.ts --out=./tmp/email-previews
 *
 * Why this exists: `tests/backfill-chunk-speed-health.route.smoke.ts`
 * substring-asserts the alert payload (shop name, MOS id, reasons,
 * link), but a regression that breaks layout — a missing closing tag,
 * a too-wide table, a malformed inline style that Outlook silently
 * eats — would slip past every existing test. This script + the
 * lightweight HTML lint catch those before they hit a paged email.
 *
 * The script:
 *   1. Builds three synthetic alert HTML files (single shop, multi-shop
 *      multi-reason, baseline-regression) so each meaningful render path
 *      gets a preview.
 *   2. Builds two recovery emails (full auto-clear and partial recovery).
 *   3. Runs the in-house HTML lint (`lintEmailHtml`) over every preview
 *      and prints the results. Errors fail the script with exit code 1
 *      so this can be wired into CI later if desired.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildAlertEmailHtml,
  buildAlertEmailSubject,
  buildRecoveryEmailHtml,
  buildRecoveryEmailSubject,
  LintIssue,
  lintEmailHtml,
} from "../app/api/cron/backfill-chunk-speed-health/email-html";
import { SlowShop } from "../app/api/cron/backfill-chunk-speed-health/lib";

function parseOutDir(): string {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (a.startsWith("--out=")) return a.slice("--out=".length);
  }
  return "tmp/email-previews";
}

const SYNC_HEALTH_URL = "https://mostools.io/platform-admin/sync-health";

// ---------------------------------------------------------------
// Synthetic fixtures — exercise every meaningful render branch.
// ---------------------------------------------------------------

function makeSlowShop(overrides: Partial<SlowShop> & { reasons: string[] }): SlowShop {
  const base: SlowShop = {
    provider: "tekmetric",
    providerLabel: "Tekmetric",
    shopId: 42,
    name: "Acme Auto Care — ACME-001",
    reasons: overrides.reasons,
    reasonsKey: [...overrides.reasons].sort().join(","),
    rollup: {
      chunkSampleCount: 25,
      p95DurationMs: 12 * 60 * 1000,
      avgBackoff429Ms: 35_000,
      jobsCacheHitRate: 0.92,
      jobsCacheTotal: 1200,
      vehiclesCacheHitRate: 0.88,
      vehiclesCacheTotal: 900,
      customersCacheHitRate: 0.81,
      customersCacheTotal: 700,
    },
    p95Baseline: null,
  };
  return { ...base, ...overrides, rollup: { ...base.rollup, ...(overrides.rollup ?? {}) } };
}

const SINGLE_SHOP_FIXTURE: Array<{ shop: SlowShop; isNew: boolean }> = [
  {
    shop: makeSlowShop({ reasons: ["slow_p95"] }),
    isNew: true,
  },
];

const MULTI_SHOP_FIXTURE: Array<{ shop: SlowShop; isNew: boolean }> = [
  {
    shop: makeSlowShop({ reasons: ["slow_p95"] }),
    isNew: true,
  },
  {
    shop: makeSlowShop({
      shopId: 88,
      name: "Big Wrench LLC — BWL-002",
      reasons: ["slow_p95", "high_backoff"],
      rollup: {
        chunkSampleCount: 25,
        p95DurationMs: 14 * 60 * 1000,
        avgBackoff429Ms: 95_000,
        jobsCacheHitRate: 0.65,
        jobsCacheTotal: 1100,
        vehiclesCacheHitRate: 0.71,
        vehiclesCacheTotal: 800,
        customersCacheHitRate: 0.6,
        customersCacheTotal: 600,
      },
    }),
    isNew: false,
  },
  {
    shop: makeSlowShop({
      provider: "protractor",
      providerLabel: "Protractor",
      shopId: 201,
      name: "Crown Garage <special> & Co — CRN-9",
      reasons: ["high_backoff", "low_jobs_cache", "low_customers_cache"],
      rollup: {
        chunkSampleCount: 18,
        p95DurationMs: 8 * 60 * 1000,
        avgBackoff429Ms: 120_000,
        jobsCacheHitRate: 0.31,
        jobsCacheTotal: 600,
        vehiclesCacheHitRate: 0.78,
        vehiclesCacheTotal: 540,
        customersCacheHitRate: 0.42,
        customersCacheTotal: 480,
      },
    }),
    isNew: true,
  },
  {
    shop: makeSlowShop({
      provider: "shopware",
      providerLabel: "Shop-Ware",
      shopId: 305,
      name: "Down-Under Auto",
      reasons: ["slow_p95", "regressed_p95", "high_backoff", "low_jobs_cache", "low_vehicles_cache", "low_customers_cache"],
      p95Baseline: 90_000,
      rollup: {
        chunkSampleCount: 25,
        p95DurationMs: 16 * 60 * 1000,
        avgBackoff429Ms: 180_000,
        jobsCacheHitRate: 0.22,
        jobsCacheTotal: 1500,
        vehiclesCacheHitRate: 0.18,
        vehiclesCacheTotal: 1100,
        customersCacheHitRate: 0.15,
        customersCacheTotal: 900,
      },
    }),
    isNew: true,
  },
];

const BASELINE_REGRESSION_FIXTURE: Array<{ shop: SlowShop; isNew: boolean }> = [
  {
    shop: makeSlowShop({
      shopId: 117,
      name: "Sunny Service Center — SSC-3",
      reasons: ["regressed_p95"],
      p95Baseline: 80_000,
      rollup: {
        chunkSampleCount: 20,
        p95DurationMs: 6 * 60 * 1000,
        avgBackoff429Ms: 4_000,
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
];

// ---------------------------------------------------------------
// Render previews
// ---------------------------------------------------------------

type Preview = {
  filename: string;
  subject: string;
  html: string;
};

const previews: Preview[] = [
  {
    filename: "alert-single-shop.html",
    subject: buildAlertEmailSubject(1, 1),
    html: buildAlertEmailHtml({
      rows: SINGLE_SHOP_FIXTURE,
      breachingTotal: 1,
      syncHealthUrl: SYNC_HEALTH_URL,
    }),
  },
  {
    filename: "alert-multi-shop.html",
    subject: buildAlertEmailSubject(MULTI_SHOP_FIXTURE.length, MULTI_SHOP_FIXTURE.length + 2),
    html: buildAlertEmailHtml({
      rows: MULTI_SHOP_FIXTURE,
      breachingTotal: MULTI_SHOP_FIXTURE.length + 2,
      syncHealthUrl: SYNC_HEALTH_URL,
    }),
  },
  {
    filename: "alert-baseline-regression.html",
    subject: buildAlertEmailSubject(1, 1),
    html: buildAlertEmailHtml({
      rows: BASELINE_REGRESSION_FIXTURE,
      breachingTotal: 1,
      syncHealthUrl: SYNC_HEALTH_URL,
    }),
  },
  {
    filename: "recovery-auto-clear.html",
    subject: buildRecoveryEmailSubject("Acme Auto Care — ACME-001"),
    html: buildRecoveryEmailHtml({
      shopId: 42,
      name: "Acme Auto Care — ACME-001",
      lastSeenP95Ms: 12 * 60 * 1000,
      lastSeenAt: new Date("2026-04-27T14:30:00Z"),
      previousReasons: ["slow_p95", "high_backoff"],
      transition: "auto_clear",
      syncHealthUrl: SYNC_HEALTH_URL,
    }),
  },
  {
    filename: "recovery-partial.html",
    subject: buildRecoveryEmailSubject("Big Wrench LLC — BWL-002"),
    html: buildRecoveryEmailHtml({
      shopId: 88,
      name: "Big Wrench LLC — BWL-002",
      lastSeenP95Ms: 13 * 60 * 1000,
      lastSeenAt: new Date("2026-04-27T15:00:00Z"),
      previousReasons: ["slow_p95", "high_backoff"],
      transition: "reasons_changed",
      syncHealthUrl: SYNC_HEALTH_URL,
    }),
  },
];

function wrapForBrowser(p: Preview): string {
  // Wrap each preview in a minimal HTML document so it renders sensibly
  // when opened directly in a browser. The original alert markup is a
  // single <div>, which is what Resend will inject into the email body
  // — keeping the wrapper minimal avoids drift between the preview and
  // the actual rendered email.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeForTitle(p.subject)}</title>
  <style>
    body { background: #f4f4f6; margin: 0; padding: 24px; }
    .preview-frame { background: #fff; max-width: 800px; margin: 0 auto;
                     border: 1px solid #e2e8f0; border-radius: 8px;
                     box-shadow: 0 1px 3px rgba(0,0,0,0.06); padding: 16px 24px; }
    .preview-meta { font-family: system-ui, sans-serif; font-size: 12px;
                    color: #64748b; margin-bottom: 12px; }
    .preview-meta strong { color: #1e293b; }
  </style>
</head>
<body>
  <div class="preview-frame">
    <div class="preview-meta"><strong>Subject:</strong> ${escapeForTitle(p.subject)}</div>
    ${p.html}
  </div>
</body>
</html>
`;
}

function escapeForTitle(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatLint(issues: LintIssue[]): string {
  if (issues.length === 0) return "  (lint clean)";
  return issues
    .map((i) => `  [${i.severity.toUpperCase()}] ${i.message}`)
    .join("\n");
}

function main(): number {
  const outDir = resolve(process.cwd(), parseOutDir());
  mkdirSync(outDir, { recursive: true });

  let errorCount = 0;
  console.log(`Writing chunk-speed alert email previews to ${outDir}`);
  for (const p of previews) {
    const path = resolve(outDir, p.filename);
    writeFileSync(path, wrapForBrowser(p), "utf8");
    const issues = lintEmailHtml(p.html);
    const errs = issues.filter((i) => i.severity === "error");
    errorCount += errs.length;
    console.log(`\n→ ${p.filename}`);
    console.log(`  subject: ${p.subject}`);
    console.log(`  bytes:   ${p.html.length}`);
    console.log(formatLint(issues));
  }

  // Index page so opening the directory in a browser is one click
  // away from every preview.
  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Chunk-Speed Alert Email Previews</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #1e293b; }
    li { margin: 8px 0; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>Chunk-Speed Alert Email Previews</h1>
  <p>Generated by <code>scripts/preview-chunk-speed-alert-email.ts</code>.</p>
  <ul>
    ${previews.map((p) => `<li><a href="./${p.filename}">${p.filename}</a> — ${escapeForTitle(p.subject)}</li>`).join("\n    ")}
  </ul>
</body>
</html>
`;
  writeFileSync(resolve(outDir, "index.html"), indexHtml, "utf8");

  console.log(
    `\nWrote ${previews.length + 1} files. Open ${resolve(outDir, "index.html")} in a browser to review.`,
  );
  if (errorCount > 0) {
    console.error(`\n✗ HTML lint found ${errorCount} error(s) — fix before sending.`);
    return 1;
  }
  console.log(`\n✓ HTML lint clean across all previews.`);
  return 0;
}

process.exit(main());
