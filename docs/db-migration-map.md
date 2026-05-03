# Database Migration Map (MongoDB → Supabase Postgres)

**Status:** living document. Update as cutover waves complete.
**Scope:** all persisted entities except CRM and Rescue Rover (being removed in a separate back-out task — see those tables marked **EXCLUDED**).
**Sources:** walked `lib/db/schema/` (Postgres / Drizzle), every `db.collection(...)` call site (Mongo), `lib/supabase-dual-writer.ts`, `lib/normalized-ingestion.ts`, and the cron / webhook entry points listed in task #296.
**Companion script:** `scripts/backfill-mongo-to-supabase.ts` is the only end-to-end Mongo→PG backfill tool today and only handles the 6 normalized collections.

Legend for "Source of truth":
- **Mongo** — Mongo is canonical; Postgres copy (if any) is a downstream mirror.
- **Postgres** — Postgres is canonical; Mongo copy (if any) is legacy.
- **Mongo + PG (dual-write)** — both are written by the same code path; reads are Mongo-first or fan-out.
- **n/a (single store)** — only one DB has it.

Legend for "Wave":
- **W0** — orphan / archived; drop without migration.
- **W1** — leaf entity, simple writer, low blast radius. Cut over first.
- **W2** — operational entity with a handful of writers; needs repository abstraction first.
- **W3** — high-fan-in entity (many writers, many readers). Needs careful soak.
- **W4** — entity that everything joins to (shops, users, sessions). Last.
- **EXCL** — out of scope for this audit.
- **BLOCKED** — depends on other work.

---

## 1. Postgres-resident tables (already canonical for their domain)

These domains live in Postgres today. Most have **no Mongo twin** and need no migration work — they're listed so the inventory is complete. A handful (marked **Conflict**) share a name with a Mongo collection that is also written somewhere; those rows are tracked here and re-listed in §5 as cross-DB risks. Do not treat the "Conflict" rows as Postgres-only during cutover.

| Entity | PG table(s) | Read paths | Write paths | Notes |
| --- | --- | --- | --- | --- |
| Communications — conversations | `conversations`, `conversation_messages`, `conversation_participants` | `lib/db/repositories/conversations.ts`, `lib/db/repositories/comm-conversations.ts`, `app/api/communications/conversations/**` | same | Twilio voice/SMS pipeline. |
| Communications — phone numbers / SMS | `phone_numbers`, `sms_contacts`, `sms_messages` | `app/api/communications/sms/**`, `app/api/webhooks/twilio/sms/route.ts` | same | |
| Communications — voicemails / transcriptions | `voicemails`, `call_transcriptions` | `lib/db/repositories/voicemails.ts`, `lib/db/repositories/comm-voicemails.ts`, `app/api/communications/voicemails/**`, `app/api/webhooks/twilio/voicemail/route.ts` | same | |
| Call center — groups, agent targets, time entries, canned messages | `groups`, `agent_targets`, `time_entries`, `canned_messages` | `lib/db/repositories/call-center.ts`, `lib/db/repositories/call-logs.ts` | same | |
| Onboarding — stages, steps, checklists, cards, progress | `onboarding_stages`, `onboarding_stage_assignments`, `onboarding_steps`, `onboarding_stage_steps`, `onboarding_checklists`, `onboarding_step_checklists`, `onboarding_cards`, `onboarding_card_progress` | `lib/repositories/onboarding-repository.ts`, `app/platform-admin/onboarding/**`, `app/api/onboarding/**` | same | Gated by `CRM_ENABLED`. |
| Onboarding — tours, guides, workflows, banners, favorites | `tours`, `user_tour_progress`, `onboarding_guides_content`, `user_onboarding_guide_progress`, `workflow_sequences`, `user_workflow_sequence_progress`, `banners`, `user_banner_progress`, `user_favorites`, `content_assignments` | same | same | Gated by `CRM_ENABLED`. |
| Sales / marketing — funnel, deals, campaigns, coupons, specials, message templates, pricing | `deal_funnel_stages`, `deals`, `campaigns`, `coupons`, `specials`, `message_templates`, `pricing_plans`, `products`, `product_features`, `promo_codes`, `getting_started_packages` | `lib/db/repositories/sales-marketing.ts`, `app/api/platform-admin/{sales-pipeline,specials,promo-codes,products,product-features,pricing-plans,message-templates}/**` | same | Gated by `CRM_ENABLED`. |
| Support tickets (new) | `support_tickets` (PG) | `app/api/support/tickets/**` | same | **Conflict:** there is also a `support_tickets` Mongo collection used by the same routes. See §5 cross-DB. |
| Production logs | `production_logs` | `lib/logs/betterstack-sync.ts`, `app/api/logs/betterstack/route.ts` | same | Mirror from Better Stack. |
| Sniffer sessions | `sniffer_sessions` | `app/api/extension/sniffer-upload/route.ts`, `app/api/platform-admin/sniffer/**` | same | |
| Enhance corrections | `enhance_corrections` | `app/api/extension/enhance-corrections/route.ts`, `app/api/extension/enhance-findings/route.ts` | same | |
| Platform features | `platform_features` (PG) | `app/api/platform-admin/features/**` | same | **Conflict:** also a Mongo `platform_features` collection read by `lib/featureResolver.ts`. PG copy appears to be the new home but Mongo is still source of truth at runtime. See §5. |
| Tekmetric migration wizard | `tekmetric_migration_runs`, `tekmetric_migration_dumps`, `tekmetric_migration_mappings`, `tekmetric_migration_audit` | `lib/tekmetric-migration/audit.ts`, `app/api/extension/tekmetric-migration/**`, `app/platform-admin/tekmetric-migrations/**` | same | |
| API usage logs (Postgres) | `api_usage_logs` (PG) | `lib/external-api/api-keys.ts` | same | **Conflict:** Mongo `api_usage_logs` also written. See §5. |

### EXCLUDED from this audit (separate back-out task)
| Entity | PG table(s) |
| --- | --- |
| CRM accounts hierarchy | `crm_agencies`, `crm_corporate_branding`, `crm_branding_themes`, `crm_parent_organizations`, `crm_accounts`, `crm_locations`, `crm_user_types`, `crm_agency_pricing_packages` |
| CRM users | `crm_users` |
| CRM contacts + entity notes/tasks | `crm_contacts`, `crm_contact_role_types`, `crm_contact_*_assignments`, `crm_entity_notes`, `crm_entity_tasks` |
| Rescue Rover | `rescue_rover_settings`, `rescue_rover_call_logs`, `rescue_rover_safety_rules`, `rescue_rover_prompt_templates`, `rescue_rover_voice_scripts`, `rescue_rover_context_rules`, `rescue_rover_rcs_links`, `api_usage_logs` (rescue-rover schema file owns this one) |

---

## 2. Dual-written entities (Mongo + Postgres, today)

The only dual-writer in the codebase is `lib/supabase-dual-writer.ts`, invoked from `lib/normalized-ingestion.ts` (the single ingestion service used by Tekmetric/Protractor/Shop-Ware sync + webhook paths). All 6 collections below are written to Mongo first, then mirrored to PG inside `dualWriteToSupabase(...)`. PG mirror failures are logged but **do not** fail the Mongo write.

| Entity | Mongo collection | PG table | Source of truth (today) | Read paths | Write paths | Reconciliation strategy |
| --- | --- | --- | --- | --- | --- | --- |
| Vehicle (normalized) | `normalized_vehicles` | `normalized_vehicles` | **Mongo** | Mongo: `lib/normalized-job-search.ts`, `app/api/estimate-assist/job-builder/route.ts`, `lib/integrations/autovitals.ts`. PG: `lib/supabase-job-search.ts` (job search fan-out). | Mongo+PG via `NormalizedIngestionService.ingestVehicle` (called from `lib/integrations/{tekmetric,protractor,shopware}/adapter.ts`, `lib/integrations/protractor-backfill.ts`, `lib/normalized-ingestion.ts` consumers). PG-only: `scripts/backfill-mongo-to-supabase.ts`. | Drift detection: row-count + sampled `provenance.contentHash` diff per shop. "Supabase wins" = re-run backfill script with `--collection=vehicles --reset` and accept PG state for in-flight rows; ingestion continues to write both until cutover. |
| Customer (normalized) | `normalized_customers` | `normalized_customers` | **Mongo** | Mongo: `lib/normalized-job-search.ts`, `scripts/verify-normalized-data.ts`. PG: `lib/supabase-job-search.ts`. | Same path as vehicles (`ingestCustomer`). | Same as vehicles. |
| Work order (normalized) | `normalized_work_orders` | `normalized_work_orders` | **Mongo** | Mongo: `lib/normalized-job-search.ts`, `scripts/repair-patterns-from-jobindex.ts`, `lib/integrations/autovitals.ts`. PG: `lib/supabase-job-search.ts`. | Same path (`ingestWorkOrder` — also embeds service jobs). Plus `scripts/fix-duplicate-source-ids.ts` (Mongo only). | Same. **Risk:** Protractor non-vehicle invoices fail PG NOT-NULL on `vehicle_id`; backfill script classifies as `data-quality skip`. Need a real fix before "PG wins". |
| Service job (normalized) | `normalized_service_jobs` | `normalized_service_jobs` | **Mongo** | Mongo: `lib/normalized-job-search.ts`, `lib/estimate-assist/job-knowledge-base.ts`. PG: `lib/supabase-job-search.ts` (the read-from-PG arm of the triple-source job search). | Embedded in `ingestWorkOrder` via `dualWriteToSupabase('service_job', ...)`. | Same. **This is the highest-traffic dual-write entity** — every Tekmetric/Protractor RO sync produces N service jobs. |
| Line item (normalized) | `normalized_line_items` | `normalized_line_items` | **Mongo** | Mongo: only `scripts/backfill-mongo-to-supabase.ts` (no production reader yet). PG: none. | Mongo: `ingestWorkOrder` writes embedded `lines[]` into the work_order doc; `normalized_line_items` Mongo collection is **rarely written separately**. PG: `SupabaseDualWriter.upsertLineItem` is wired but currently only invoked from the backfill script. | **Status: PG side is effectively orphaned right now.** Either (a) wire the live ingestion path to call `upsertLineItem`, or (b) drop the PG table from the dual-write list and make line items derive from `normalized_work_orders.rawData` on read. |
| Payment (normalized) | `normalized_payments` | `normalized_payments` | **Mongo** | Mongo: `scripts/verify-normalized-data.ts`. PG: none. | Mongo+PG via `ingestPayment` (when adapter emits payments — currently Tekmetric only). | Low blast radius (no production reader on either side). Safe to cut over once a reader exists. |

**Cron / webhook entry points that drive these dual-writes** (matches task #296's "17 known dual-writing files"):
- `app/api/cron/tekmetric-backfill/route.ts`
- `app/api/cron/tekmetric-sync/route.ts`
- `app/api/cron/tekmetric-ro-retry/route.ts`
- `app/api/cron/protractor-sync/route.ts`
- `app/api/cron/shopware-backfill/route.ts`
- `app/api/cron/shopware-sync/route.ts`
- `app/api/webhooks/tekmetric/route.ts`
- `app/api/webhooks/shopware/route.ts`
- `app/api/webhooks/protractor/[token]/route.ts`
- `lib/integrations/protractor-backfill.ts`
- `lib/tekmetric-incremental-sync.ts`
- `lib/integrations/tekmetric/adapter.ts`
- `lib/integrations/shopware/adapter.ts`
- `lib/integrations/protractor/adapter.ts`
- `lib/normalized-ingestion.ts` (the actual dual-writer)
- `scripts/protractor-sync-standalone.ts`
- `scripts/drain-{tekmetric,protractor}-backfill.ts`

---

## 3. Mongo-only entities (no PG mirror today)

Grouped by domain. "PG plan" calls out the wave each one belongs to.

### 3.1 Identity / tenancy (W4 — last to migrate)

| Collection | Source of truth | Readers | Writers | Notes |
| --- | --- | --- | --- | --- |
| `shops` | Mongo | `lib/shops.ts`, `lib/auth.ts`, `lib/stripe.ts`, `lib/featureResolver.ts`, virtually every cron + API route, all integration adapters | `lib/shops.ts`, `app/api/stripe/webhook/route.ts`, `app/api/settings/{autoflow,shopware,protractor,billing}/route.ts`, `app/api/enterprise/shops/route.ts`, `app/api/sticker/settings/route.ts`, `app/api/internal/backfill-labor-rates/route.ts` | Highest fan-in entity in the system. **W4.** |
| `users` | Mongo | `lib/auth.ts`, `app/api/user/**`, `app/api/settings/users/**`, `app/api/enterprise/users/**`, `app/api/platform-admin/users/route.ts` | `app/api/stripe/webhook/route.ts`, `app/api/settings/users/[userId]/route.ts`, `app/api/enterprise/{users,shops}/route.ts`, `app/api/auth/complete-setup/route.ts` | **W4.** |
| `sessions` | Mongo | `lib/auth.ts`, `app/api/settings/shopware/{,webhook/}route.ts` | `app/api/auth/login/route.ts`, `app/api/user/switch-shop/route.ts`, `app/api/enterprise/users/route.ts` | **W4.** Cross-DB risk: every authenticated request reads this from Mongo before any PG read. |
| `shop_users` | Mongo | `app/api/platform-admin/tickets/route.ts` | (writes via `users`) | Likely orphan view — verify and drop. **W0?** |
| `enterprise_accounts` | Mongo | `lib/enterprise.ts`, `app/api/enterprise/{billing,users}/route.ts` | `app/api/enterprise/{billing,mappings}/route.ts` | **W4** (joined to shops). |
| `platform_admins` | Mongo | `lib/super-admins.ts`, `app/api/platform-admin/**` | `scripts/seed-platform-admin.ts`, `scripts/set-platform-admin.ts` | **W4.** |
| `platform_settings` | Mongo | `lib/stripe.ts`, `app/api/platform-admin/{billing,settings}/route.ts` | `lib/stripe.ts`, `app/api/platform-admin/settings/route.ts`, `app/api/admin/billing/settings/route.ts` | **W3.** |
| `platform_plans` | Mongo | `app/api/stripe/plans/route.ts` | `app/api/platform-admin/plans/seed/route.ts` | **W2.** Small, rarely written. |
| `platform_features` | Mongo (canonical), PG twin exists | `lib/featureResolver.ts`, `app/api/features/route.ts`, `app/api/stripe/plans/route.ts`, `app/api/platform-admin/features/route.ts` | `app/api/platform-admin/features/{,seed,reorder}/route.ts` | **Cross-DB conflict** — see §5. |
| `shop_features` | Mongo | `lib/features.ts` | `lib/features.ts` | **W3.** Per-shop feature overrides. |
| `pending_signups`, `setup_tokens`, `password_reset_tokens`, `password_resets` | Mongo | auth flows | auth flows | **W3** (auth-adjacent). `password_resets` is legacy index-only — probably W0. |

### 3.2 Billing / Stripe (W3)

| Collection | Readers | Writers | Notes |
| --- | --- | --- | --- |
| `billing_settings` | `app/api/admin/billing/**`, `app/api/settings/billing/route.ts` | same | |
| `billing_status_log` | (none in app) | `app/api/admin/billing/{extend-grace,grace-period-check}/route.ts` | Append-only audit. |
| `stripe_events`, `stripe_webhook_events` | `app/api/stripe/webhook/route.ts` | same | Idempotency / audit. |

### 3.3 Integration source-of-truth caches (W2 once dependencies settle)

These are per-integration mirrors of remote SMS data. They feed `normalized_ingestion`, so they're upstream of the dual-written entities; cutover order matters.

| Collection | Readers | Writers | Notes |
| --- | --- | --- | --- |
| `tekmetric_work_orders` | `lib/tekmetric-job-index.ts`, `lib/tekmetric-incremental-sync.ts`, `app/api/dashboard/data/route.ts`, `lib/plan-builder.ts`, `lib/vhi-rebuild.ts`, `app/api/extension/jobs/search/route.ts` | `lib/tekmetric-sync.ts`, `lib/tekmetric-incremental-sync.ts`, `app/api/webhooks/tekmetric/route.ts`, `app/api/cron/tekmetric-backfill/route.ts` | Hot path. **W3.** |
| `tekmetric_repair_orders` | (lookup-only inside extension job-search) | `app/api/cron/tekmetric-backfill/route.ts` | Possible duplicate of `tekmetric_work_orders`; verify before W2/W3 split. |
| `tekmetric_vehicles`, `tekmetric_vehicle_cache`, `tekmetric_customer_cache`, `tekmetric_jobs_cache`, `tekmetric_canned_jobs_cache` | various Tekmetric paths above + `lib/tekmetric-bulk-jobs.ts`, `lib/tekmetric-jobs-prewarm.ts` | same | Per-shop caches, can stay on Mongo until hot path is migrated. |
| `tekmetric_tokens` | `lib/tekmetric-auth.ts`, `lib/integrations/tekmetric/auth.ts` | same | OAuth tokens. **W3** (security-sensitive). |
| `tekmetric_api_usage` | `app/api/platform-admin/tekmetric-usage/route.ts` | `lib/tekmetric-usage-tracker.ts` | Append-only metric. |
| `tekmetric_backfill_progress`, `tekmetric_backfill_health_alerts`, `tekmetric_permfailed_ro_alerts`, `tekmetric_skipped_ro_archive`, `tekmetric_catchup_runs`, `tekmetric_mileage_backfill_progress` | cron + admin sync-health + drain script | same | Operational state — small, **W1/W2**. |
| `tekmetric_drain_lock` | `scripts/drain-tekmetric-backfill.ts` | same | Mongo-backed distributed lock. **Cross-DB risk** if PG cron jobs need the same lock. |
| `tekmetric_webhook_logs`, `tekmetric_webhook_subscriptions`, `tekmetric_webhook_health_alerts` | `app/api/webhooks/tekmetric/route.ts`, `app/api/cron/tekmetric-webhook-health/route.ts`, `lib/tekmetric-webhook-subscribe.ts` | same | **W2.** |
| `protractor_work_orders`, `protractor_invoices`, `protractor_invoice_cache`, `protractor_vehicles`, `protractor_canned_jobs`, `protractor_canned_jobs_cache`, `protractor_ro_cache`, `protractor_template_cache`, `protractor_service_items`, `protractor_deferred_work`, `protractor_callback_events` | `lib/integrations/protractor.ts`, `lib/protractor-jobs-prewarm.ts`, `app/api/cron/protractor-sync/route.ts`, `lib/auto-booking/scheduler.ts`, `app/api/dashboard/data/route.ts`, `lib/vhi-rebuild.ts`, `app/api/webhooks/protractor/[token]/route.ts` | same | Mirror of Protractor's REST/SOAP API. **W3.** |
| `shopware_repair_orders`, `shopware_vehicles`, `shopware_customers`, `shopware_backfill_progress`, `shopware_webhook_logs` | `lib/shopware-jobs-prewarm.ts`, cron + webhook routes, `app/api/dashboard/data/route.ts`, `app/api/plan-build/route.ts` | same | **W3.** |
| `autoflow_credentials`, `autoflow_dvi_items`, `autoflow_events`, `af_open` | `lib/integrations/autoflow.ts`, `lib/integrations/autoflow/client.ts`, `lib/evidence.ts` | same | **W3.** |
| `autovitals_vehicles`, `autovitals_inspections`, `autovitals_appointments`, `autovitals_imports` | `lib/integrations/autovitals.ts`, `app/api/autovitals/**` | same | **W3.** |

### 3.4 Reference / lookup data (mostly DataOne ETL — W1/W2)

| Collection | Readers | Writers | Notes |
| --- | --- | --- | --- |
| `dataone_cache` | `lib/integrations/dataone-api.ts` | same | Hot lookup. |
| `dataone_lkp_squish_maintenance`, `dataone_oe`, `def_maintenance_event`, `lkp_ymm_maintenance_interval` | `lib/integrations/dataone-local.ts`, `lib/evidence.ts` | `scripts/dataone-import.ts` (and parallel `scripts/dataone-postgres-import.ts` already exists for PG side) | **W1.** Read-mostly reference data. PG migration largely done by ETL script. |
| `LKP_VIN_MAINTENANCE`, `LKP_YMM_MAINTENANCE`, `DEF_MAINTENANCE_EVENT`, `services_by_ymm`, `serviceevents`, `vehicleschedules`, `inspectionfindings`, `analyses`, `oeschedules` | only `_archive/**` | only `_archive/**` | **W0 — orphans.** Safe to drop. |
| `oem_schedules` | `app/api/autovitals/extension/vehicle-data/route.ts` | `lib/integrations/carfax.ts` | **W2.** |
| `oem_carfax_mappings` | `app/api/extension/plan/route.ts`, `app/api/platform-admin/service-mappings/route.ts` | `app/api/platform-admin/service-mappings/route.ts` | **W2.** Small mapping table. |
| `carfax_reports`, `carfax_history`, `carfax_cache` | `lib/integrations/carfax.ts`, `lib/evidence.ts` | same + `app/api/carfax/debug/[vin]/route.ts` | **W3.** |
| `part_cross_ref` | `lib/job-index.ts` | `lib/job-index.ts` | **W1.** |
| `knowledge_articles` | `lib/knowledge-base.ts` | same + `scripts/seed-knowledge-base.ts` | **W1.** |

### 3.5 Plans, recommendations, AI caches (W2/W3)

| Collection | Readers | Writers | Notes |
| --- | --- | --- | --- |
| `plans`, `plan_cache`, `plan_prefetch_cache`, `cached_plans`, `cached_work_orders` | `lib/plan-builder.ts`, `lib/plan-cache.ts`, `app/api/report/[vin]/route.ts`, `app/api/plan-build/route.ts`, `app/api/deferred/remedy/route.ts`, `lib/integrations/{shopware,tekmetric}/adapter.ts`, `scripts/scan-stale-plan-cache.ts` | same | Multiple overlapping caches; consolidation is its own task. **W3.** |
| `recommendations`, `recommendations_cache`, `recommendation_events` | `lib/recommendations/index.ts`, `app/api/external/recommendations/[vin]/route.ts`, `app/api/autovitals/extension/vehicle-data/route.ts`, `app/api/shop/analytics/route.ts` | same | **W3.** |
| `ai_analysis_cache`, `maintenance_analysis_cache`, `ai_budget_alerts`, `vhi_analysis_log` | `lib/ai-budget.ts`, `lib/vhi-score.ts`, `lib/vhi-webhook-trigger.ts`, `app/api/recommended/cache/route.ts`, `app/api/external/vehicles/[vin]/vhi/route.ts`, `app/api/report/[vin]/route.ts` | same + `scripts/invalidate-task-{163,166}-caches.ts` | **W2** (caches — easy to nuke and rebuild). |
| `concern_conversations` | `app/api/{dashboard,extension}/concern-assistant/route.ts` | same | **W2.** |
| `viewed_vins` | `lib/plan-cache.ts`, `lib/usage.ts` | `lib/plan-cache.ts` | **W1.** |
| `report_approved_items`, `remedied_deferred_work` | `app/api/report/[vin]/route.ts`, `app/api/extension/plan/route.ts`, `app/api/deferred/remedy/route.ts`, `app/dashboard/vehicles/[vin]/plan/page.tsx` | same | **W2.** |
| `shop_repair_patterns` | `lib/repair-patterns.ts`, `scripts/setup-repair-patterns-indexes.ts` | `lib/repair-patterns.ts`, `scripts/backfill-repair-patterns.ts` | **W2.** |

### 3.6 Job index + pre-normalization stores (W3, blocked on §2)

| Collection | Readers | Writers | Notes |
| --- | --- | --- | --- |
| `job_index` | `lib/job-index.ts`, `lib/tekmetric-job-index.ts`, `lib/integrations/protractor.ts`, `app/api/{jobs,extension/jobs}/search/route.ts`, `scripts/job-match-calibration.ts` | `lib/normalized-ingestion.ts` (`writeToJobIndex`), `scripts/protractor-job-index-catchup.ts`, `scripts/tekmetric-history-backfill.ts` | One of the three triple-source job-search arms. **BLOCKED** on `normalized_service_jobs` cutover (PG mirror needs to be canonical first). |
| `job_history` | `app/api/platform-admin/shops/route.ts` | `lib/normalized-ingestion.ts` | **W2.** Append-only. |
| `jobs` | `app/api/vehicles/[vin]/refresh/route.ts` | `app/api/vehicles/[vin]/refresh/route.ts` | Possibly orphaned legacy — verify. |
| `repair_orders`, `vehicles`, `customers`, `manual_vehicles` | `lib/data-quality.ts`, `lib/recommendations/index.ts`, `lib/evidence.ts`, `lib/vhi-rebuild.ts`, `app/api/vehicle-analyzer/route.ts`, `app/api/customers/route.ts`, `app/api/dashboard/data/route.ts`, `app/api/communications/caller-lookup/route.ts`, `app/dashboard/vehicles/[vin]/page.tsx` | `lib/upsert-customer.ts`, `lib/models/customers.ts`, `lib/integrations/dvi.ts`, `app/api/vehicles/manual/route.ts`, `scripts/protractor-sync-standalone.ts` | **Pre-normalized layer**, predates `normalized_*`. **W3** but heavy refactor — readers should be migrated to `normalized_*` first, then both sides die together. |
| `sms_historical_work_orders` | `scripts/{tekmetric,protractor}-history-backfill.ts` | `lib/integrations/protractor-backfill.ts` | **W1** (backfill scratch space). |
| `dvi`, `dvi_results` | `lib/integrations/{dvi,autoflow}.ts` | same | **W3.** |
| `canned_jobs`, `canned_job_applications` | `app/api/extension/plan/route.ts`, `app/api/{tekmetric,extension/jobs}/apply-canned*/route.ts` | `lib/integrations/{tekmetric,protractor}/adapter.ts`, same routes | **W3.** |
| `enrichment_queue`, `extension_prefetch_locks`, `auto_booking_queue` | `app/api/enrichment/process/route.ts`, `app/api/autovitals/bulk-sync/route.ts`, `app/api/extension/plan/route.ts`, `lib/auto-booking/scheduler.ts`, `app/api/settings/auto-booking/pending-count/route.ts` | same | Queue/lock structures. **W2** but watch out — PG migration may want to use `pg_advisory_lock` or `LISTEN/NOTIFY` instead of porting the schema as-is. |

### 3.7 External-API surface (W2)

| Collection | Readers | Writers | Notes |
| --- | --- | --- | --- |
| `external_api_appointments`, `external_api_keytags`, `external_api_stickers` | `app/api/external/{appointments,keytags,stickers}/route.ts` | same | Self-contained. **W2.** |
| `api_keys` | `lib/external-api/api-keys.ts`, `app/api/platform-admin/partner-keys/route.ts` | same | **W3** (auth-adjacent). |
| `api_usage`, `api_usage_logs`, `usage_logs` | `lib/ai-budget.ts`, `lib/rescue-rover/client-context.ts`, `app/api/admin/api-usage/route.ts`, `app/api/platform-admin/{api-usage/summary,stats}/route.ts`, `app/api/shop/analytics/route.ts`, `lib/external-api/api-keys.ts` | `lib/api-usage-tracker.ts`, `lib/external-api/api-keys.ts`, `app/api/platform-admin/api-usage/**` | **`api_usage_logs` is dual-stored** (Mongo and PG). See §5. |

### 3.8 Operational / observability (W1/W2)

| Collection | Readers | Writers | Notes |
| --- | --- | --- | --- |
| `admin_audit_logs`, `audit_logs` | `lib/audit-log.ts`, `app/api/platform-admin/vhi-analytics/route.ts`, `app/api/stripe/webhook/route.ts` | same + `app/api/stripe/webhook/route.ts` | **W2.** Append-only. |
| `notifications` | `lib/notifications.ts`, `app/api/platform-admin/notifications/**` | same | **W2.** |
| `dashboard_updates` | `app/api/dashboard/updates/route.ts` | all webhook routes (`tekmetric`, `shopware`, `protractor`), `app/api/vehicles/manual/route.ts`, `app/api/dashboard/protractor/create-work-order/route.ts` | **W2.** |
| `sync_metrics`, `ingestion_errors` | `lib/sync-metrics.ts`, `app/api/admin/sync-health/route.ts` | same | **W1.** |
| `data_quality_reports` | `app/api/cron/data-quality/route.ts` | same | **W1.** |
| `extension_analytics` | `lib/extension-analytics.ts` | same | **W1.** |
| `system_announcements` | `lib/announcements.ts`, `app/api/announcements/active/route.ts`, `app/api/admin/announcements/route.ts` | same | **W1.** |
| `support_tickets` (Mongo) | `app/api/support/tickets/**` | same | **Conflict with PG `support_tickets`.** See §5. |
| `support_chat_sessions` | `lib/support-chat.ts` | same | **W2.** |
| `tickets` | `app/api/support/tickets/route.ts` (legacy read), `lib/integrations/dvi.ts` writes | mostly orphan | Possibly **W0**. |
| `events` | `lib/evidence.ts` reads, `lib/integrations/{tekmetric,protractor}/adapter.ts` writes | same | Audit timeline used by VHI / evidence. **W3.** |
| `webhook_events` | only `_archive/**` | only `_archive/**` | **W0 — orphan.** |
| `workflow_runs` | `app/api/workflows/runs/route.ts` only | (no writer found in app code) | Likely **W0** unless external writer exists. |
| `ratelimits` | `lib/rate.ts` | same | **W1.** Could be Redis instead of PG. |
| `counters` | `lib/ids.ts`, `app/api/platform-admin/shops/route.ts`, `app/api/enterprise/shops/route.ts` | same | ID generation. **W3** — needs an atomic increment story in PG (`SERIAL`/sequence). |
| `sticker_generations`, `sticker_qr_scans`, `shop_media` | sticker routes | sticker routes | **W2.** |

---

## 4. Orphans (drop candidates)

### 4.1 Mongo collections with no live readers in `app/`, `lib/`, or `scripts/` (only `_archive/` references)

These are safe to drop after a final point-in-time export.

- `webhook_events`
- `oeschedules`
- `services_by_ymm`
- `vehicleschedules`
- `serviceevents`
- `inspectionfindings` (writer is in `_archive`; live writer in `lib/integrations/dvi.ts` may have been retired — verify)
- `analyses`
- `LKP_VIN_MAINTENANCE` (uppercase variant — modern code uses `lkp_ymm_maintenance_interval`)
- `LKP_YMM_MAINTENANCE`
- `DEF_MAINTENANCE_EVENT` (uppercase variant)
- `password_resets` (legacy; `password_reset_tokens` is the live one)

### 4.2 Likely orphans (verify before dropping)

- `shop_users` — only one reader, no writer.
- `workflow_runs` — only a reader, no writer in the searched paths.
- `tickets` — superseded by `support_tickets`.
- `jobs` — only one reader/writer pair, possibly debug-only.
- `tekmetric_repair_orders` — appears redundant with `tekmetric_work_orders`.
- `protractor_invoices` — overlaps `protractor_invoice_cache`.

### 4.3 Postgres tables with no live writers

None found in scope. The dual-write line items / payments situation in §2 is the closest to an orphan: PG writes only happen via the backfill script today, no live ingestion. If we don't fix that, the PG tables stay near-empty and can be dropped instead of migrated.

---

## 5. Cross-DB dependencies & explicit cutover risks

These are places where a single request or job needs both DBs. Each one is a hard ordering constraint on the migration waves.

| # | Location | Mongo side | Postgres side | Risk on cutover |
| --- | --- | --- | --- | --- |
| 1 | `lib/auth.ts` | reads `sessions`, `users`, `shops` | (none today; session middleware is Mongo-only) | Every authenticated request to a PG-only feature already does a Mongo round-trip. If we move sessions to PG, we must do it **before** anything else that breaks Mongo availability. |
| 2 | `app/api/communications/**` (Twilio voice/SMS) | reads `shops`, `users` for tenancy | writes `conversations`, `phone_numbers`, `voicemails`, etc. | Live cross-DB write in the same handler. PG transaction cannot include Mongo's tenancy lookup. Acceptable as-is, but a transient Mongo outage already breaks PG-only call flows. |
| 3 | `app/api/jobs/search/route.ts` & `app/api/extension/jobs/search/route.ts` | reads `job_index`, `normalized_*` (Mongo arm), `shops` | reads `normalized_service_jobs` (PG) via `lib/supabase-job-search.ts` | Triple-source fan-out. Documented in `replit.md`. Cutover: turn off the Mongo arms only after PG mirror has full content-hash parity for ≥7 days. |
| 4 | `app/api/extension/jobs/search/route.ts` (vehicle context) | reads `tekmetric_work_orders`, `tekmetric_repair_orders` | (none) | Only blocks extension job search if those collections move. **W3** ordering: keep these on Mongo until the rest of the extension flow is on PG. |
| 5 | `lib/featureResolver.ts` | reads `platform_features`, `shop_features`, `shops` | (none) | But PG has a `platform_features` table written by `app/api/platform-admin/features/**`. **Drift risk: admin edits PG; runtime reads Mongo.** Fix: pick one, mirror-write the other until runtime is migrated. |
| 6 | `lib/external-api/api-keys.ts` | reads/writes Mongo `api_usage_logs` | reads/writes PG `api_usage_logs` | Two different `api_usage_logs` stores, both written by the same module. Need to confirm whether they hold different shapes or one is dead. |
| 7 | `app/api/support/tickets/**` | reads/writes `support_tickets` (Mongo) | PG `support_tickets` table exists in `lib/db/schema/support-tickets.ts` | Same name, both populated somewhere. Need to confirm canonical. |
| 8 | `app/api/stripe/webhook/route.ts` | writes `users`, `shops`, `pending_signups`, `audit_logs`, `stripe_webhook_events` | (none today) | If we move `shops` or `users` first, the Stripe webhook becomes a cross-DB transaction. Keep `shops`/`users` in W4 to avoid this. |
| 9 | `lib/normalized-ingestion.ts` (`dualWriteToSupabase`) | writes Mongo (must succeed) | writes PG (best-effort, swallows errors) | Cutover risk: when PG becomes canonical, the failure semantics flip. The dual-writer must be reworked so PG failure fails the request before we can retire Mongo. This is the **single most important refactor** for the migration. |
| 10 | `lib/normalized-ingestion.ts` (`writeToJobIndex`, `writeToRepairPatterns`) | reads + writes `job_index`, `shop_repair_patterns` | (none — no PG mirror) | These are downstream Mongo writes that fan out from the same ingestion. Migrating `normalized_*` to PG without also migrating `job_index` will leave a stale Mongo derivative. |
| 11 | `scripts/drain-tekmetric-backfill.ts` | acquires `tekmetric_drain_lock` in Mongo | writes via `backfillShopChunk` which touches PG (dual-write) | Single-DB lock guarding a multi-DB write. If Mongo goes down mid-drain, PG state is left ambiguous. |
| 12 | `lib/auto-booking/scheduler.ts` | reads `protractor_vehicles`, `auto_booking_queue` | (none) | Self-contained on Mongo, but the booking decisions flow into webhooks that write `dashboard_updates` (Mongo) and indirectly trigger `normalized_ingestion` (dual-write). |

---

## 6. Proposed migration waves

Each wave should be its own task with: (a) a repository-layer PR, (b) a backfill script extending `scripts/backfill-mongo-to-supabase.ts`, (c) a soak window with content-hash drift verification, (d) PR to flip reads to PG, (e) PR to retire Mongo writes.

### Wave 0.5 — landmine clearing (prerequisite to everything in Waves 1–4)

These four items are explicit prerequisites. Skipping any of them makes later waves either silently lossy or blocked on rework. Each is small enough to be its own task; do not bundle the failure-semantics flip with the investigation work, because the flip is a single-file change and the investigation may take days.

1. **Investigation spike — answer the four open questions in §7.**
   Read-only Mongo + ripgrep work. Append answers in place to §7 of this doc.
   - Are `normalized_line_items` / `normalized_payments` PG tables intended to be live? If dead, drop them now and shrink the §2 dual-write list from 6 to 4.
   - Which copy is canonical *today* in production for `platform_features`, `support_tickets`, `api_usage_logs`?
   - Does anything outside this repo write `workflow_runs`?
   - Are `dvi`, `dvi_results`, `inspectionfindings`, `tickets` still in active use, or do they belong in Wave 0?
2. **Fix `platform_features` runtime drift** (production correctness bug, not migration work).
   `lib/featureResolver.ts` reads Mongo at runtime; the admin UI in `app/api/platform-admin/features/**` writes the PG `platform_features` table. Admin edits can appear to succeed and never take effect. Pick one canonical store and make the other a mirror until cutover.
3. **Flip `dualWriteToSupabase` failure semantics** (`lib/supabase-dual-writer.ts`).
   PG mirror failures must fail the request, not be swallowed. Without this, promoting any §2 entity to "PG canonical" silently loses data.
   **Kill switch is non-negotiable, not optional.** With ~330 rooftops on live ingestion, a Supabase outage or latency spike after the flip must be revertible to best-effort writes in under 60 seconds **without a deploy**. Implementation: a runtime-checked env var (e.g. `SUPABASE_WRITES_REQUIRED=true|false`) read on every write, plus a per-entity success/failure metric so we can detect when to flip it.
4. **Wire `upsertLineItem` / `upsertPayment` into live ingestion, or drop the PG tables** (depends on #1 answer).
   **This is a Wave 3 scope gate.** The spike's answer materially changes Wave 3 sizing: if the tables are dead, Wave 3 shrinks (drop the tables, normalized dual-write list goes from 6 to 4). If they need to be wired live, that's a non-trivial ingestion change that must be sized and built **before Wave 1 starts** — not discovered mid-Wave 3 when source-of-truth is already flipping on the highest-traffic entities. The spike must explicitly close this gate before Wave 1 kicks off.

Wave 0 orphan drops can run in parallel with #1–#3 since they touch different code.

### Wave 0 — orphan drops (no migration; pure cleanup)
- All collections in §4.1.
- Verify and drop §4.2 candidates.
- Drop unused PG tables if `normalized_line_items` / `normalized_payments` stay no-reader.

### Wave 1 — leaf reference / scratch data, no foreign keys to anything that moves later
- `dataone_*` (PG ETL already exists — promote PG to canonical).
- `oem_carfax_mappings`, `part_cross_ref`, `knowledge_articles`.
- `viewed_vins`, `system_announcements`.
- `sync_metrics`, `ingestion_errors`, `data_quality_reports`, `extension_analytics`.
- `sms_historical_work_orders` (script-only).

### Wave 2 — operational state, single-domain readers/writers
- `notifications`, `audit_logs`, `admin_audit_logs`, `dashboard_updates`.
- AI / plan caches: `plan_cache`, `cached_plans`, `ai_analysis_cache`, `maintenance_analysis_cache`, `vhi_analysis_log`, `ai_budget_alerts`, `recommendations_cache`.
- Sticker / external-API surface: `external_api_*`, `sticker_generations`, `sticker_qr_scans`, `shop_media`.
- Tekmetric/Protractor/Shopware operational state: `*_backfill_progress`, `*_health_alerts`, `*_skipped_ro_archive`, `*_catchup_runs`, `*_webhook_*`.
- Protractor/Tekmetric `*_canned_jobs_cache`, `*_invoice_cache`, `*_jobs_cache`.
- `concern_conversations`, `report_approved_items`, `remedied_deferred_work`, `shop_repair_patterns`.

### Wave 3 — high-fan-in operational entities
- §2 dual-write entities (`normalized_vehicles`/`customers`/`work_orders`/`service_jobs`/`line_items`/`payments`) — flip source of truth to PG, retire Mongo writes.
- `job_index`, `job_history`, `repair_orders`, `vehicles`, `customers`, `manual_vehicles`, `dvi*`, `events`, `canned_jobs*`.
- Per-integration source caches: `tekmetric_*`, `protractor_*`, `shopware_*`, `autoflow_*`, `autovitals_*`, `carfax_*`.
- Billing / Stripe state: `billing_settings`, `billing_status_log`, `stripe_*`, `pending_signups`, `setup_tokens`, `password_reset_tokens`.
- Auth-adjacent: `api_keys`, `api_usage`, `api_usage_logs`, `usage_logs`, `ratelimits`, `counters` (sequence rework).
- Queues/locks: `enrichment_queue`, `extension_prefetch_locks`, `auto_booking_queue`, `tekmetric_drain_lock` (consider PG-native primitives).

### Wave 4 — tenancy core (last)
- `shops`, `users`, `sessions`, `enterprise_accounts`, `shop_users` (or drop).
- `platform_admins`, `platform_settings`, `platform_plans`, `platform_features` (resolve §5 #5 first), `shop_features`.
- `support_tickets` (resolve §5 #7 first), `support_chat_sessions`, `tickets` (or drop).

### Blocked / dependent
- Wave 3 normalized rollout is **blocked** on:
  - Fix `normalized_line_items` / `normalized_payments` PG dual-write (§2).
  - Reverse failure semantics in `dualWriteToSupabase` (§5 #9).
  - Resolve duplicated stores: `platform_features`, `support_tickets`, `api_usage_logs` (§5 #5–7).
- Wave 4 is **blocked** on Wave 3 (everything joins to `shops` / `users`).

---

## 7. Open questions for the cutover task owners

1. Are `normalized_line_items` / `normalized_payments` PG tables intended to be live (so we wire `upsertLineItem`/`upsertPayment` into the live ingestion path), or to be dropped?
2. For `platform_features`, `support_tickets`, `api_usage_logs` — which copy is canonical today and how did the duplicate arise?
3. Is the `tekmetric_drain_lock` concept staying in Mongo post-migration, or are we porting it to a PG advisory lock at the same time?
4. Does anything outside this repo write to `workflow_runs`?
5. Are `dvi`, `dvi_results`, `inspectionfindings`, `tickets` still in active use, or can they move to Wave 0?
