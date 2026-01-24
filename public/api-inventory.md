# MOS Tools API Inventory

Generated: 2026-01-24

## Summary
- **Total Endpoints:** 240
- **External API Endpoints:** 6
- **Internal Endpoints:** 234

---

## External API (Partner Available)

These endpoints are available to partners via API keys.

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/external/appointments` |  | Create and manage appointments |
| `/api/external/keytags` |  | Generate keytags |
| `/api/external/recommendations/:vin` |  | AI-powered maintenance recommendations |
| `/api/external/stickers` |  | Generate oil change stickers |
| `/api/external/vehicles/:vin` |  | Vehicle information and maintenance schedules |
| `/api/external/vehicles/:vin/maintenance` |  | Vehicle information and maintenance schedules |

---

## Internal APIs by Category

### Authentication

| Endpoint | Methods |
|----------|----------|
| `/api/auth/complete-setup` | POST |
| `/api/auth/forgot` | POST |
| `/api/auth/invite` | POST |
| `/api/auth/login` | POST |
| `/api/auth/logout` | POST |
| `/api/auth/me` | GET |
| `/api/auth/reset` | POST |
| `/api/auth/setup` | POST |

### Chrome Extension

| Endpoint | Methods |
|----------|----------|
| `/api/extension/analytics/push-to-ro` | POST |
| `/api/extension/auth` | POST |
| `/api/extension/canned-jobs` | GET |
| `/api/extension/download` | GET |
| `/api/extension/jobs/search` | GET |
| `/api/extension/keytag` | GET, POST |
| `/api/extension/plan` | GET |
| `/api/extension/sticker` | GET, POST |
| `/api/extension/version` | GET |

### Customers

| Endpoint | Methods |
|----------|----------|
| `/api/customers` | GET, POST |
| `/api/customers/:customerId` | GET |
| `/api/customers/:customerId/close` | POST |
| `/api/customers/:customerId/inspect` | GET |

### Enterprise

| Endpoint | Methods |
|----------|----------|
| `/api/enterprise` | GET, POST, PUT |
| `/api/enterprise/analytics` | GET |
| `/api/enterprise/billing` | GET, PUT |
| `/api/enterprise/billing/change-plan` | POST |
| `/api/enterprise/billing/invoices` | GET |
| `/api/enterprise/billing/portal` | POST |
| `/api/enterprise/billing/purchase-vins` | POST |
| `/api/enterprise/copy-settings` | GET, POST |
| `/api/enterprise/locations` | GET |
| `/api/enterprise/mappings` | GET, POST |
| `/api/enterprise/shops` | GET, POST, DELETE |
| `/api/enterprise/users` | GET, POST |

### Jobs & History

| Endpoint | Methods |
|----------|----------|
| `/api/jobs/add-to-ro` | POST |
| `/api/jobs/autocomplete` | GET |
| `/api/jobs/open-work-orders` | GET |
| `/api/jobs/search` | GET, POST |
| `/api/jobs/search-normalized` | GET |
| `/api/jobs/stats` | GET |

### Keytags

| Endpoint | Methods |
|----------|----------|
| `/api/keytag/generate` | POST |
| `/api/keytag/settings` | GET, POST |

### Notifications

| Endpoint | Methods |
|----------|----------|
| `/api/notifications` | GET, POST |
| `/api/notifications/:id` | PATCH, DELETE |
| `/api/notifications/count` | GET |

### Other

| Endpoint | Methods |
|----------|----------|
| `/api/analyze` | POST |
| `/api/assets/:filename` | GET |
| `/api/callbacks/protractor` | GET, POST |
| `/api/carfax/debug/:vin` | GET |
| `/api/cobrowse/config` | GET |
| `/api/dashboard/data` | GET |
| `/api/dashboard/data-v2` | GET |
| `/api/dashboard/enterprise-users` | GET, POST |
| `/api/dashboard/recent` | GET |
| `/api/dashboard/updates` | GET |
| `/api/docs` | GET |
| `/api/e2e/token` | GET, POST |
| `/api/enrichment/process` | GET, POST |
| `/api/events/autoflow/recent` | GET |
| `/api/events/list` | GET |
| `/api/features` | GET |
| `/api/health` | GET |
| `/api/internal/plan-pregenerate` | POST |
| `/api/onboarding/integrations-status` | GET |
| `/api/ping` | GET |
| `/api/plan-prefetch` | GET, POST |
| `/api/plan-prefetch/batch` | POST |
| `/api/trial/view-vin` | GET, POST |
| `/api/workflows/runs` | GET |

### Parts

| Endpoint | Methods |
|----------|----------|
| `/api/parts/build-database` | POST |
| `/api/parts/build-history` | GET, POST |
| `/api/parts/compatible` | GET |
| `/api/parts/rebuild` | POST |
| `/api/parts/search` | GET |

### Recommendations

| Endpoint | Methods |
|----------|----------|
| `/api/recommended/analyze` | POST |
| `/api/recommended/analyze-stream` | POST |
| `/api/recommended/cache` | GET, POST |

### Settings

| Endpoint | Methods |
|----------|----------|
| `/api/settings/addons` | GET |
| `/api/settings/api-keys` | GET, POST, PATCH, DELETE |
| `/api/settings/auto-booking` | GET, POST |
| `/api/settings/auto-booking/pending-count` | GET |
| `/api/settings/auto-booking/queue` | GET, POST |
| `/api/settings/autoflow` | GET, POST, DELETE |
| `/api/settings/billing` | GET |
| `/api/settings/branding` | GET, POST, DELETE |
| `/api/settings/canned-job-mappings` | GET, POST |
| `/api/settings/carfax` | GET, POST, DELETE |
| `/api/settings/extensions` | GET, POST |
| `/api/settings/extensions/generate-key` | POST |
| `/api/settings/extensions/revoke-key` | POST |
| `/api/settings/inspection` | GET, POST |
| `/api/settings/integration-setup` | POST |
| `/api/settings/integrations` | GET |
| `/api/settings/invites/:inviteId` | DELETE |
| `/api/settings/preferences` | GET, PUT |
| `/api/settings/protractor` | GET, POST, DELETE |
| `/api/settings/protractor/test` | POST |
| `/api/settings/tekmetric` | GET, POST, DELETE |
| `/api/settings/users` | GET |
| `/api/settings/users/:userId` | GET, PATCH, DELETE |
| `/api/settings/workflows` | GET, POST |

### Shop

| Endpoint | Methods |
|----------|----------|
| `/api/shop/analytics` | GET |
| `/api/shop/features` | GET |
| `/api/shops` | POST |
| `/api/shops/:shopId/credentials` | GET, PUT |
| `/api/shops/list` | GET |

### Stickers

| Endpoint | Methods |
|----------|----------|
| `/api/sticker/finalize-logo` | POST |
| `/api/sticker/generate` | POST |
| `/api/sticker/logo/:shopId/:filename` | GET |
| `/api/sticker/qr` | GET, POST |
| `/api/sticker/redirect/:shopId` | GET |
| `/api/sticker/regenerate-qr` | POST |
| `/api/sticker/settings` | GET, PUT, DELETE |
| `/api/sticker/upload-logo` | POST |

### Support

| Endpoint | Methods |
|----------|----------|
| `/api/support/chat` | GET, POST |
| `/api/support/chat/escalate` | POST |
| `/api/support/chat/resolve` | POST |
| `/api/support/tickets` | GET, POST |
| `/api/support/tickets/:ticketId` | GET, POST |
| `/api/support/tickets/count` | GET |

### User

| Endpoint | Methods |
|----------|----------|
| `/api/user/profile` | GET |
| `/api/user/shops` | GET |
| `/api/user/switch-shop` | POST |

### Vehicles

| Endpoint | Methods |
|----------|----------|
| `/api/vehicle-analyzer` | POST |
| `/api/vehicle/close/:vin` | POST |
| `/api/vehicle/common-failures` | GET |
| `/api/vehicle/driving-stats` | GET |
| `/api/vehicles/:vin/components` | GET, PATCH |
| `/api/vehicles/:vin/declined` | GET, POST, DELETE |
| `/api/vehicles/:vin/refresh` | GET, POST |
| `/api/vehicles/check-closed-orders` | POST |
| `/api/vehicles/close-work-order` | POST |

### Admin (Internal) (Not recommended for external)

| Endpoint | Methods |
|----------|----------|
| `/api/admin/audit-logs` | GET |
| `/api/admin/billing/settings` | POST |
| `/api/admin/billing/sync-stripe` | GET |
| `/api/admin/data-quality` | GET, POST |
| `/api/admin/database/collections` | GET |
| `/api/admin/database/permissions` | GET |
| `/api/admin/database/query` | POST |
| `/api/admin/database/write` | POST |
| `/api/admin/db-indexes` | POST |
| `/api/admin/extension-analytics` | GET |
| `/api/admin/features` | GET |
| `/api/admin/features/:shopId` | GET, POST, PUT |
| `/api/admin/hovercode-qrs` | GET, POST |
| `/api/admin/normalized-stats` | GET |
| `/api/admin/promote-user` | POST |
| `/api/admin/shops` | GET, POST |
| `/api/admin/shops/:shopId/autoflow` | GET, PUT |
| `/api/admin/shops/:shopId/autoflow/test` | POST |
| `/api/admin/shops/:shopId/invite` | POST |
| `/api/admin/sync-health` | GET |
| `/api/admin/usage` | GET |

### Billing (Internal) (Not recommended for external)

| Endpoint | Methods |
|----------|----------|
| `/api/billing/config` | GET |
| `/api/stripe/billing-portal` | POST |
| `/api/stripe/change-plan` | POST |
| `/api/stripe/create-checkout` | POST |
| `/api/stripe/invoices` | GET |
| `/api/stripe/payment-methods` | GET |
| `/api/stripe/plans` | GET |
| `/api/stripe/prices` | GET |
| `/api/stripe/webhook` | POST |

### Cron (Internal) (Not recommended for external)

| Endpoint | Methods |
|----------|----------|
| `/api/cron/dashboard-refresh` | GET, POST |
| `/api/cron/data-quality` | POST |
| `/api/cron/protractor-backfill` | GET |
| `/api/cron/protractor-sync` | GET |
| `/api/cron/tekmetric-backfill` | GET |
| `/api/cron/tekmetric-incremental-sync` | GET |
| `/api/cron/tekmetric-sync` | GET |

### Development (Internal) (Not recommended for external)

| Endpoint | Methods |
|----------|----------|
| `/api/debug-env` | GET |
| `/api/debug/dashboard` | GET |
| `/api/debug/dashboard-data` | GET |
| `/api/debug/events` | GET |
| `/api/debug/session` | GET |
| `/api/dev/clear-vehicles` | DELETE |
| `/api/dev/fix-session` | GET |

### Integrations (Internal) (Not recommended for external)

| Endpoint | Methods |
|----------|----------|
| `/api/autovitals/bulk-sync` | GET, POST |
| `/api/autovitals/extension/connect` | POST |
| `/api/autovitals/extension/download` | GET |
| `/api/autovitals/extension/generate-key` | POST, DELETE |
| `/api/autovitals/extension/sync` | POST |
| `/api/autovitals/extension/sync-vehicles` | POST |
| `/api/autovitals/extension/vehicle-data` | GET |
| `/api/autovitals/inspection/:appointmentId` | GET |
| `/api/autovitals/settings` | GET, POST, DELETE |
| `/api/autovitals/sync` | GET, POST |
| `/api/autovitals/test` | POST |
| `/api/autovitals/vehicles` | GET |
| `/api/protractor/apply-canned-job` | POST |
| `/api/protractor/canned-jobs` | GET |
| `/api/protractor/canned-jobs/enrich` | POST |
| `/api/protractor/debug` | GET |
| `/api/protractor/inspections` | GET |
| `/api/protractor/sync` | GET, POST |
| `/api/tekmetric/apply-canned-job` | POST |
| `/api/tekmetric/canned-jobs` | GET |
| `/api/tekmetric/labels` | GET |
| `/api/tekmetric/sync` | POST |

### Platform Admin (Internal) (Not recommended for external)

| Endpoint | Methods |
|----------|----------|
| `/api/platform-admin/api-usage` | GET |
| `/api/platform-admin/api-usage/errors` | GET |
| `/api/platform-admin/api-usage/shops/:shopId` | GET |
| `/api/platform-admin/billing` | GET |
| `/api/platform-admin/cobrowse/devices` | GET |
| `/api/platform-admin/enterprises` | GET, POST |
| `/api/platform-admin/enterprises/:enterpriseId` | GET, PATCH, DELETE |
| `/api/platform-admin/features` | GET, POST, PATCH, DELETE |
| `/api/platform-admin/features/reorder` | POST |
| `/api/platform-admin/features/seed` | POST |
| `/api/platform-admin/impersonate` | POST |
| `/api/platform-admin/knowledge-base` | GET, POST |
| `/api/platform-admin/knowledge-base/:id` | GET, PATCH, DELETE |
| `/api/platform-admin/knowledge-base/from-ticket` | POST |
| `/api/platform-admin/login` | POST |
| `/api/platform-admin/notifications` | GET, POST |
| `/api/platform-admin/notifications/:id` | PATCH, DELETE |
| `/api/platform-admin/notifications/count` | GET |
| `/api/platform-admin/plans/seed` | POST |
| `/api/platform-admin/render-logs` | GET |
| `/api/platform-admin/settings` | GET, POST |
| `/api/platform-admin/shops` | GET |
| `/api/platform-admin/shops/:shopId` | GET, PATCH, DELETE |
| `/api/platform-admin/shops/:shopId/vins` | POST |
| `/api/platform-admin/stats` | GET |
| `/api/platform-admin/stripe/products` | GET, POST |
| `/api/platform-admin/tekmetric-usage` | GET |
| `/api/platform-admin/tickets` | GET, POST, PATCH |
| `/api/platform-admin/tickets/:ticketId` | GET, DELETE |
| `/api/platform-admin/tickets/count` | GET |
| `/api/platform-admin/tickets/reports` | GET |
| `/api/platform-admin/usage` | GET |
| `/api/platform-admin/users` | GET |
| `/api/platform-admin/users/:userId` | GET, PATCH, DELETE |

### Webhooks (Internal) (Not recommended for external)

| Endpoint | Methods |
|----------|----------|
| `/api/webhooks/autoflow/:token` | GET, POST |
| `/api/webhooks/protractor/:token` | GET, POST |
| `/api/webhooks/tekmetric` | GET, POST |

---

## Recommended Additions to External API

Based on partner needs, consider adding:

1. **Customers API** - `/api/customers` - CRM integrations need customer data
2. **Jobs Search** - `/api/jobs/search` - Service history lookup
3. **Common Failures** - `/api/vehicle/common-failures` - Predictive maintenance
4. **Declined Services** - `/api/vehicles/:vin/declined` - Follow-up opportunities
5. **Parts Search** - `/api/parts/search` - Parts ordering integrations
