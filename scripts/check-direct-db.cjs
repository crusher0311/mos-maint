#!/usr/bin/env node
/* eslint-disable */
// scripts/check-direct-db.cjs
//
// Forbids new direct calls to the Mongo getDb() / getMongoClient()
// outside the repository layer. App code MUST import a function from
// `lib/data/repositories/<entity>.ts` instead.
//
// During the gradual migration introduced in task #298 we keep an
// explicit allowlist of files that still call getDb()/getMongoClient()
// directly. New entries in the allowlist should NOT be added — instead,
// move the data-access call into a repository.
//
// To run: `node scripts/check-direct-db.cjs`

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();

// Files that are still allowed to import getDb()/getMongoClient()
// directly. This list is the legacy backlog we are paying down.
// Do NOT add to this list — fold the access into a repo under
// lib/data/repositories/ instead.
const ALLOWLIST = new Set([
  "app/admin/analytics/page.tsx",
  "app/admin/integrations/carfax/page.tsx",
  "app/admin/page.tsx",
  "app/admin/shops/page.tsx",
  "app/admin/system/page.tsx",
  "app/admin/users/page.tsx",
  "app/api/admin/api-usage/route.ts",
  "app/api/admin/billing/extend-grace/route.ts",
  "app/api/admin/billing/grace-period-check/route.ts",
  "app/api/admin/billing/settings/route.ts",
  "app/api/admin/clear-plan-cache/route.ts",
  "app/api/admin/clear-template-cache/route.ts",
  "app/api/admin/concern-skip-stats/route.ts",
  "app/api/admin/database/collections/route.ts",
  "app/api/admin/database/query/route.ts",
  "app/api/admin/database/write/route.ts",
  "app/api/admin/db-indexes/route.ts",
  "app/api/admin/features/route.ts",
  "app/api/admin/features/[shopId]/route.ts",
  "app/api/admin/hovercode-qrs/route.ts",
  "app/api/admin/normalized-stats/route.ts",
  "app/api/admin/promote-user/route.ts",
  "app/api/admin/shops/route.ts",
  "app/api/admin/shops/[shopId]/autoflow/route.ts",
  "app/api/admin/shops/[shopId]/invite/route.ts",
  "app/api/admin/sync-health/protractor/route.ts",
  "app/api/admin/sync-health/route.ts",
  "app/api/admin/sync-health/shopware/route.ts",
  "app/api/admin/sync-health/skipped-ros/resolve/route.ts",
  "app/api/admin/sync-health/tekmetric/route.ts",
  "app/api/admin/tekmetric-endpoint-health/route.ts",
  "app/api/auth/change-password/route.ts",
  "app/api/auth/complete-setup/route.ts",
  "app/api/auth/forgot/route.ts",
  "app/api/auth/invite/route.ts",
  "app/api/auth/login/route.ts",
  "app/api/auth/me/route.ts",
  "app/api/auth/reset/route.ts",
  "app/api/auth/setup-complete/route.ts",
  "app/api/auth/setup/route.ts",
  "app/api/auth/setup-shop/route.ts",
  "app/api/autovitals/bulk-sync/route.ts",
  "app/api/autovitals/extension/connect/route.ts",
  "app/api/autovitals/extension/generate-key/route.ts",
  "app/api/autovitals/extension/sync/route.ts",
  "app/api/autovitals/extension/sync-vehicles/route.ts",
  "app/api/autovitals/extension/vehicle-data/route.ts",
  "app/api/autovitals/settings/route.ts",
  "app/api/autovitals/sync/route.ts",
  "app/api/autovitals/vehicles/route.ts",
  "app/api/callbacks/protractor/route.ts",
  "app/api/carfax/debug/[vin]/route.ts",
  "app/api/communications/caller-lookup/route.ts",
  "app/api/cron/backfill-chunk-speed-health/route.ts",
  "app/api/cron/backfill-reconcile/route.ts",
  "app/api/cron/catchup-status/route.ts",
  "app/api/cron/cron-health-alerter/route.ts",
  "app/api/cron/data-quality/route.ts",
  "app/api/cron/invoice-cache-refresh/route.ts",
  "app/api/cron/protractor-backfill/route.ts",
  "app/api/cron/protractor-sync/route.ts",
  "app/api/cron/shopware-backfill/route.ts",
  "app/api/cron/shopware-enrich/route.ts",
  "app/api/cron/shopware-sync/route.ts",
  "app/api/cron/tekmetric-backfill-health/route.ts",
  "app/api/cron/tekmetric-backfill/route.ts",
  "app/api/cron/tekmetric-fullpage-backfill/route.ts",
  "app/api/platform-admin/shops/[shopId]/fullpage-reindex/route.ts",
  "app/api/cron/tekmetric-endpoint-health/route.ts",
  "app/api/cron/tekmetric-incremental-sync/route.ts",
  "app/api/cron/tekmetric-probe/route.ts",
  "app/api/cron/tekmetric-ro-retry/route.ts",
  "app/api/cron/tekmetric-sync/route.ts",
  "app/api/cron/tekmetric-webhook-health/route.ts",
  "app/api/cron/trial-check/route.ts",
  "app/api/customers/[customerId]/inspect/route.ts",
  "app/api/customers/[customerId]/route.ts",
  "app/api/dashboard/concern-assistant/route.ts",
  "app/api/dashboard/data/route.ts",
  "app/api/dashboard/data-v2/route.ts",
  "app/api/dashboard/enterprise-users/route.ts",
  "app/api/dashboard/protractor/canned-jobs/route.ts",
  "app/api/dashboard/protractor/contacts/route.ts",
  "app/api/dashboard/protractor/create-work-order/route.ts",
  "app/api/dashboard/protractor/deferred-work/route.ts",
  "app/api/dashboard/protractor/job-history/route.ts",
  "app/api/dashboard/protractor/vehicles/route.ts",
  "app/api/dashboard/recent/route.ts",
  "app/api/dashboard/updates/route.ts",
  "app/api/debug/dashboard-data/route.ts",
  "app/api/deferred/remedy/route.ts",
  "app/api/dev/clear-vehicles/route.ts",
  "app/api/dev/session-logs/route.ts",
  "app/api/enrichment/process/route.ts",
  "app/api/enterprise/analytics/route.ts",
  "app/api/enterprise/billing/change-plan/route.ts",
  "app/api/enterprise/billing/invoices/route.ts",
  "app/api/enterprise/billing/portal/route.ts",
  "app/api/enterprise/billing/route.ts",
  "app/api/enterprise/copy-settings/route.ts",
  "app/api/enterprise/copy-sticker-settings/route.ts",
  "app/api/enterprise/locations/route.ts",
  "app/api/enterprise/mappings/route.ts",
  "app/api/enterprise/route.ts",
  "app/api/enterprise/shops/route.ts",
  "app/api/enterprise/users/route.ts",
  "app/api/estimate-assist/audit/history/route.ts",
  "app/api/estimate-assist/audit/route.ts",
  "app/api/estimate-assist/job-builder/route.ts",
  "app/api/extension/auth/route.ts",
  "app/api/extension/auth-token/route.ts",
  "app/api/extension/build-ro-from-vhi/route.ts",
  "app/api/extension/canned-jobs/route.ts",
  "app/api/extension/concern-assistant/inject-protractor/route.ts",
  "app/api/extension/concern-assistant/route.ts",
  "app/api/extension/inspections/route.ts",
  "app/api/extension/jobs/add-to-ro/route.ts",
  "app/api/extension/jobs/apply-canned/route.ts",
  "app/api/extension/jobs/search/route.ts",
  "app/api/extension/keytag/route.ts",
  "app/api/extension/labor-rates/route.ts",
  "app/api/extension/plan/route.ts",
  "app/api/extension/preferences/route.ts",
  "app/api/extension/ro-context/route.ts",
  "app/api/extension/sticker/route.ts",
  "app/api/extension/tek-endpoint-report/route.ts",
  "app/api/external/appointments/route.ts",
  "app/api/external/recommendations/[vin]/route.ts",
  "app/api/external/shops/route.ts",
  "app/api/external/vehicles/[vin]/maintenance/route.ts",
  "app/api/external/vehicles/[vin]/route.ts",
  "app/api/external/vehicles/[vin]/vhi/route.ts",
  "app/api/external/vhi/analyze/route.ts",
  "app/api/ghost-mode/status/route.ts",
  "app/api/internal/backfill-labor-rates/route.ts",
  "app/api/internal/plan-pregenerate/route.ts",
  "app/api/internal/prefetch-shops/route.ts",
  "app/api/internal/prefetch-vehicles/route.ts",
  "app/api/jobs/add-to-ro-batch/route.ts",
  "app/api/jobs/autocomplete/route.ts",
  "app/api/jobs/open-work-orders/route.ts",
  "app/api/jobs/search-normalized/route.ts",
  "app/api/jobs/search/route.ts",
  "app/api/jobs/stats/route.ts",
  "app/api/keytag/generate/route.ts",
  "app/api/keytag/settings/route.ts",
  "app/api/logs/betterstack/route.ts",
  "app/api/onboarding/integrations-status/route.ts",
  "app/api/parts/build-database/route.ts",
  "app/api/parts/build-history/route.ts",
  "app/api/parts/compatible/route.ts",
  "app/api/parts/rebuild/route.ts",
  "app/api/parts/search/route.ts",
  "app/api/plan-build/diagnostics/route.ts",
  "app/api/plan-build/route.ts",
  "app/api/plan-prefetch/batch/route.ts",
  "app/api/plan-prefetch/route.ts",
  "app/api/platform-admin/api-usage/summary/route.ts",
  "app/api/platform-admin/backfill/route.ts",
  "app/api/platform-admin/billing/export/route.ts",
  "app/api/platform-admin/billing/route.ts",
  "app/api/platform-admin/client-health/route.ts",
  "app/api/platform-admin/cron-status/route.ts",
  "app/api/platform-admin/emergency-reset/route.ts",
  "app/api/platform-admin/engine-risk-overrides/export/route.ts",
  "app/api/platform-admin/engine-risk-overrides/import/route.ts",
  "app/api/platform-admin/engine-risk-overrides/imports/[importId]/csv/route.ts",
  "app/api/platform-admin/engine-risk-overrides/imports/route.ts",
  "app/api/platform-admin/engine-risk-overrides/route.ts",
  "app/api/platform-admin/enterprises/[enterpriseId]/route.ts",
  "app/api/platform-admin/enterprises/route.ts",
  "app/api/platform-admin/impersonate/route.ts",
  "app/api/platform-admin/login/route.ts",
  "app/api/platform-admin/log-stream/route.ts",
  "app/api/platform-admin/notifications/count/route.ts",
  "app/api/platform-admin/notifications/[id]/route.ts",
  "app/api/platform-admin/notifications/route.ts",
  "app/api/platform-admin/partner-keys/route.ts",
  "app/api/platform-admin/plans/seed/route.ts",
  "app/api/platform-admin/protractor-rewarm-jobs-cache-all/route.ts",
  "app/api/platform-admin/service-keys/route.ts",
  "app/api/platform-admin/service-mappings/carfax-names/route.ts",
  "app/api/platform-admin/service-mappings/route.ts",
  "app/api/platform-admin/settings/route.ts",
  "app/api/platform-admin/shops/backfill-review-state/route.ts",
  "app/api/platform-admin/shops/bulk-approve/route.ts",
  "app/api/platform-admin/shops/bulk-card-capture/route.ts",
  "app/api/platform-admin/shops/lookup/route.ts",
  "app/api/platform-admin/shops/route.ts",
  "app/api/platform-admin/shops/[shopId]/backfill/route.ts",
  "app/api/platform-admin/shops/[shopId]/protractor-rewarm-jobs-cache/route.ts",
  "app/api/platform-admin/shops/[shopId]/protractor-run-now/route.ts",
  "app/api/platform-admin/shops/[shopId]/review/route.ts",
  "app/api/platform-admin/shops/[shopId]/ro-retry/route.ts",
  "app/api/platform-admin/shops/[shopId]/route.ts",
  "app/api/platform-admin/shops/[shopId]/shopware-rewarm-jobs-cache/route.ts",
  "app/api/platform-admin/shops/[shopId]/shopware-run-now/route.ts",
  "app/api/platform-admin/shops/[shopId]/tekmetric-rewarm-jobs-cache/route.ts",
  "app/api/platform-admin/shops/[shopId]/tekmetric-run-now/route.ts",
  "app/api/platform-admin/shopware-rewarm-jobs-cache-all/route.ts",
  "app/api/platform-admin/stats/route.ts",
  "app/api/platform-admin/tekmetric/index-source-breakdown/route.ts",
  "app/api/platform-admin/tekmetric/normalized-ingestion-breakdown/route.ts",
  "app/api/platform-admin/tekmetric-rewarm-jobs-cache-all/route.ts",
  "app/api/platform-admin/tekmetric-ro-retry/route.ts",
  "app/api/platform-admin/tekmetric-usage/route.ts",
  "app/api/platform-admin/tekmetric/webhook-subscription-status/route.ts",
  "app/api/platform-admin/tickets/route.ts",
  "app/api/platform-admin/users/route.ts",
  "app/api/platform-admin/users/[userId]/reset-password/route.ts",
  "app/api/platform-admin/users/[userId]/route.ts",
  "app/api/protractor/apply-canned-job/route.ts",
  "app/api/protractor/debug/route.ts",
  "app/api/protractor/sync/route.ts",
  "app/api/recommended/analyze/route.ts",
  "app/api/recommended/analyze-stream/route.ts",
  "app/api/recommended/cache/route.ts",
  "app/api/report/[vin]/route.ts",
  "app/api/settings/auto-booking/pending-count/route.ts",
  "app/api/settings/auto-booking/route.ts",
  "app/api/settings/autoflow/route.ts",
  "app/api/settings/billing/route.ts",
  "app/api/settings/branding/route.ts",
  "app/api/settings/canned-job-mappings/route.ts",
  "app/api/settings/carfax/route.ts",
  "app/api/settings/create-ro/route.ts",
  "app/api/settings/extensions/generate-key/route.ts",
  "app/api/settings/extensions/revoke-key/route.ts",
  "app/api/settings/extensions/route.ts",
  "app/api/settings/inspection/route.ts",
  "app/api/settings/integration-setup/route.ts",
  "app/api/settings/integrations/route.ts",
  "app/api/settings/invites/[inviteId]/route.ts",
  "app/api/settings/labor-rates/route.ts",
  "app/api/settings/preferences/route.ts",
  "app/api/settings/protractor/route.ts",
  "app/api/settings/shopware/route.ts",
  "app/api/settings/shopware/webhook/route.ts",
  "app/api/settings/tekmetric/route.ts",
  "app/api/settings/users/route.ts",
  "app/api/settings/users/[userId]/route.ts",
  "app/api/settings/workflows/route.ts",
  "app/api/shop/analytics/route.ts",
  "app/api/shop/features/route.ts",
  "app/api/shops/list/route.ts",
  "app/api/shops/route.ts",
  "app/api/shops/[shopId]/credentials/route.ts",
  "app/api/sticker/finalize-logo/route.ts",
  "app/api/sticker/generate/route.ts",
  "app/api/sticker/logo/[...path]/route.ts",
  "app/api/sticker/qr-cache/route.ts",
  "app/api/sticker/qr/route.ts",
  "app/api/sticker/redirect/[shopId]/route.ts",
  "app/api/sticker/regenerate-qr/route.ts",
  "app/api/sticker/settings/route.ts",
  "app/api/sticker/upload-logo/route.ts",
  "app/api/stripe/billing-portal/route.ts",
  "app/api/stripe/change-plan/route.ts",
  "app/api/stripe/create-checkout/route.ts",
  "app/api/stripe/invoices/route.ts",
  "app/api/stripe/payment-methods/route.ts",
  "app/api/stripe/plans/route.ts",
  "app/api/stripe/webhook/route.ts",
  "app/api/tekmetric/apply-canned-job/route.ts",
  "app/api/tekmetric/canned-jobs/route.ts",
  "app/api/tekmetric/job-categories/route.ts",
  "app/api/tekmetric/labels/route.ts",
  "app/api/tekmetric/sync/route.ts",
  "app/api/trial/view-vin/route.ts",
  "app/api/user/shops/route.ts",
  "app/api/user/switch-shop/route.ts",
  "app/api/vehicle-analyzer/route.ts",
  "app/api/vehicle/common-failures/route.ts",
  "app/api/vehicle/driving-stats/route.ts",
  "app/api/vehicles/check-closed-orders/route.ts",
  "app/api/vehicles/close-work-order/route.ts",
  "app/api/vehicles/manual/route.ts",
  "app/api/vehicles/[vin]/components/route.ts",
  "app/api/vehicles/[vin]/declined/route.ts",
  "app/api/vehicles/[vin]/oil-duty/route.ts",
  "app/api/vehicles/[vin]/refresh/route.ts",
  "app/api/vehicles/[vin]/vhi/route.ts",
  "app/api/webhooks/autoflow/[token]/route.ts",
  "app/api/webhooks/protractor/[token]/route.ts",
  "app/api/webhooks/tekmetric/route.ts",
  "app/api/workflows/runs/route.ts",
  "app/dashboard/parts/page.tsx",
  "app/dashboard/settings/autoflow/page.tsx",
  "app/dashboard/settings/carfax/page.tsx",
  "app/dashboard/settings/intervals/page.tsx",
  "app/dashboard/settings/maintenance/page.tsx",
  "app/dashboard/vehicles/[vin]/page.tsx",
  "app/dashboard/vehicles/[vin]/plan/page-fixed.tsx",
  "app/dashboard/vehicles/[vin]/plan/page.tsx",
  "app/dashboard/vehicles/[vin]/recommend/page.tsx",
  "lib/ai-budget.ts",
  "lib/audit-log.ts",
  "lib/auth.ts",
  "lib/common-failures.ts",
  "lib/data-quality.ts",
  "lib/email.ts",
  "lib/estimate-assist/job-knowledge-base.ts",
  "lib/evidence.ts",
  "lib/extension-analytics.ts",
  "lib/extension-auth.ts",
  "lib/extension-shop-lookup.ts",
  "lib/featureResolver.ts",
  "lib/ids.ts",
  "lib/integrations/autoflow/client.ts",
  "lib/integrations/autoflow.ts",
  "lib/integrations/backfill-pace.ts",
  "lib/integrations/carfax.ts",
  "lib/integrations/dataone-api.ts",
  "lib/integrations/dataone.ts",
  "lib/integrations/dvi.ts",
  "lib/integrations/protractor-backfill.ts",
  "lib/integrations/protractor/client.ts",
  "lib/integrations/protractor/jobs-prewarm.ts",
  "lib/integrations/protractor/sync.ts",
  "lib/integrations/shopware/adapter.ts",
  "lib/integrations/tekmetric/auth.ts",
  "lib/integrations/tekmetric/incremental-sync.ts",
  "lib/integrations/tekmetric/job-index.ts",
  "lib/integrations/tekmetric/jobs-prewarm.ts",
  "lib/integrations/tekmetric/shared-rate-limiter.ts",
  "lib/integrations/tekmetric/sync.ts",
  "lib/integrations/tekmetric/usage-tracker.ts",
  "lib/integrations/tekmetric/webhook-subscribe.ts",
  "lib/job-index.ts",
  "lib/models/customers.ts",
  "lib/rate.ts",
  "lib/repair-patterns.ts",
  "lib/scripts/backfill-integration-provider.ts",
  "lib/shops.ts",
  "lib/shopware-jobs-prewarm.ts",
  "lib/stripe.ts",
  "lib/super-admins.ts",
  "lib/sync-metrics.ts",
  "lib/tekmetric-migration/tokenCache.ts",
  "lib/usage.ts",
  "lib/vhi-rebuild.ts",
  "scripts/backfill-concern-conversations-mos-shop-id.ts",
  "scripts/backfill-job-index-aces.ts",
  "scripts/cleanup-task-277-vin-billing-fields.ts",
  "scripts/drain-protractor-backfill.ts",
  "scripts/drain-tekmetric-backfill.ts",
  "scripts/job-index-aces-coverage.ts",
  "scripts/protractor-job-index-catchup.ts",
  "scripts/wave1-backfill.ts",
]);

// Paths that are *always* allowed to use getDb()/getMongoClient():
//   - the repository layer itself
//   - the mongo module that provides the handle
//   - one-off migration / drain scripts
const ALLOWED_PREFIXES = [
  'lib/data/',
  'lib/mongo.ts',
  'scripts/drain-',
];

const ALLOWED_SUBSTRINGS = [
  '/migration/',
  '-migration.',
  'migrate-',
];

function isAlwaysAllowed(rel) {
  if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) return true;
  if (ALLOWED_SUBSTRINGS.some((s) => rel.includes(s))) return true;
  return false;
}

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.next' ||
        entry.name === '_archive' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === 'build'
      ) continue;
      yield* walk(full);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
    ) {
      yield full;
    }
  }
}

const offenders = [];
// Catch direct imports from the underlying Mongo helper AND from the
// new repository-layer entry point. The latter is meant to be called
// only by files inside `lib/data/repositories/` (and itself); any
// other caller would re-introduce the same coupling we are paying
// down by smuggling getDb() through a different module path.
const mongoImportRegex = /from\s+['"](?:@\/lib\/mongo|(?:\.\.?\/)+mongo)['"]/;
const dataDbImportRegex = /from\s+['"](?:@\/lib\/data\/db|(?:\.\.?\/)+data\/db|\.\/db)['"]/;
const callRegex = /\b(?:getDb|getMongoClient)\s*\(/;

// Files that are allowed to import from `@/lib/data/db` directly —
// the repository layer itself.
function isRepositoryLayer(rel) {
  return rel.startsWith('lib/data/');
}

for (const abs of walk(ROOT)) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (isAlwaysAllowed(rel)) continue;
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  if (!callRegex.test(content)) continue;

  const importsMongo = mongoImportRegex.test(content);
  const importsDataDb = dataDbImportRegex.test(content);

  if (importsDataDb && !isRepositoryLayer(rel)) {
    // Smuggling getDb() through the repository module from outside
    // the repository layer is never allowed and is not allowlistable.
    offenders.push(rel + ' (imports @/lib/data/db outside lib/data/)');
    continue;
  }

  if (!importsMongo) continue;
  if (ALLOWLIST.has(rel)) continue;
  offenders.push(rel);
}

if (offenders.length > 0) {
  console.error(
    `\n[check-direct-db] ${offenders.length} file(s) call getDb()/getMongoClient() directly without being on the allowlist:\n`
  );
  for (const o of offenders) console.error('  -', o);
  console.error(
    '\nAdd a function in lib/data/repositories/<entity>.ts and call it from these files instead.\n' +
    'See docs/data-access.md for details.\n'
  );
  process.exit(1);
}

const stale = [...ALLOWLIST].filter((rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return true;
  const content = fs.readFileSync(abs, 'utf8');
  return !(mongoImportRegex.test(content) && callRegex.test(content));
});

if (stale.length > 0) {
  console.warn(
    `\n[check-direct-db] ${stale.length} stale allowlist entr${stale.length === 1 ? 'y' : 'ies'} (file no longer needs to be allowlisted — please remove from scripts/check-direct-db.cjs):\n`
  );
  for (const s of stale) console.warn('  -', s);
}

console.log(
  `[check-direct-db] OK — ${ALLOWLIST.size - stale.length} allowlisted file(s); 0 unauthorized direct getDb()/getMongoClient() calls.`
);
