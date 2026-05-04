# Database Migration Map (MongoDB → Supabase Postgres)

**Status:** living document. Update as cutover waves complete.
**Scope:** all persisted entities except CRM and Rescue Rover (being removed in a separate back-out task — see those tables marked **EXCLUDED**).
**Sources:** walked `lib/db/schema/` (Postgres / Drizzle), every `db.collection(...)` call site (Mongo), `lib/supabase-dual-writer.ts`, `lib/normalized-ingestion.ts`, and the cron / webhook entry points listed in task #296.
**Companion script:** `scripts/backfill-mongo-to-supabase.ts` is the only end-to-end Mongo→PG backfill tool today and only handles the 6 normalized collections.

**Wave 0 status (2026-05-03, task #341):** complete. All nine confirmed-orphan collections in §4.1 (`webhook_events`, `serviceevents`, `vehicleschedules`, `inspectionfindings`, `analyses`, `oeschedules`, `LKP_VIN_MAINTENANCE`, `LKP_YMM_MAINTENANCE`, `DEF_MAINTENANCE_EVENT`) were re-grepped against the live tree and confirmed orphaned, then verified absent from the production Mongo cluster (already gone — likely dropped during the original DataOne retirement). Five §4.2 "verify before dropping" candidates turned out to still have live callers and were reclassified instead of dropped: `password_resets` → W3, `services_by_ymm` → W2, `tickets` → W3, `shop_users` → W4, `workflow_runs` → W2. Snapshot + decision log: `docs/audits/2026-05-03-wave0-mongo-orphan-drop.md`.

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

## 2. Dual-written entities (Mongo + Postgres) — **W3a polarity flip landed (task #344, 2026-05-04)**

**Status as of W3a flip:** Postgres is now **canonical** for all six normalized
entities. Each ingestion path writes PG first via
`NormalizedIngestionService.dualWriteToSupabase(...)` (renamed in spirit to
`writeToPgCanonical` — the JS method name is kept to keep call-site diffs
small) which **awaits PG and re-throws on failure** — a Postgres outage now
fails the ingestion request rather than silently dropping data. Mongo
writes happen *after* the PG write and are gated behind the runtime
kill-switch `WRITE_MONGO_NORMALIZED` (default ON for the W3a soak; flip to
`"0"` after each per-entity 24–168 h soak passes — see §10). Mongo failures
are logged but never thrown, so a Mongo outage cannot break ingestion.

The shadow flag is read on **every** write so it is a no-deploy kill switch
in either direction (resume Mongo mirroring by unsetting it, halt by
setting it to `"0"`). Mongo reads (change-detection `findOne` + downstream
consumers) still go through Mongo during the soak — those move to PG in the
W3a-followup task.

| Entity | Mongo collection | PG table | Source of truth | Read paths | Write paths | Cutover status |
| --- | --- | --- | --- | --- | --- | --- |
| Vehicle (normalized) | `normalized_vehicles` | `normalized_vehicles` | **Postgres** | Mongo: `app/api/estimate-assist/job-builder/route.ts`, `lib/integrations/autovitals.ts`. PG: `lib/supabase-job-search.ts` (sole job-search reader since task #299). | PG canonical via `ingestVehicle`; Mongo shadow gated on `WRITE_MONGO_NORMALIZED`. | **W3a code landed** — soak in progress. Mongo readers above need to be moved to PG before `WRITE_MONGO_NORMALIZED=0` is set. |
| Customer (normalized) | `normalized_customers` | `normalized_customers` | **Postgres** | Mongo: `scripts/verify-normalized-data.ts`. PG: `lib/supabase-job-search.ts`. | PG canonical via `ingestCustomer`; Mongo shadow. | **W3a code landed.** |
| Work order (normalized) | `normalized_work_orders` | `normalized_work_orders` | **Postgres** | Mongo: `scripts/repair-patterns-from-jobindex.ts`, `lib/integrations/autovitals.ts`. PG: `lib/supabase-job-search.ts`. | PG canonical via `ingestWorkOrder` (also embeds service jobs); Mongo shadow. | **W3a code landed.** Protractor non-vehicle invoice crash fixed: `vehicle_id` / `vehicle` are now nullable on `normalized_work_orders` (drizzle/0013_*). The dual-writer's defensive skip block was removed. |
| Service job (normalized) | `normalized_service_jobs` | `normalized_service_jobs` | **Postgres** | Mongo: `lib/estimate-assist/job-knowledge-base.ts`. PG: `lib/supabase-job-search.ts` is the sole job-search reader (task #299, step 5). | PG canonical via embedded write inside `ingestWorkOrder`; Mongo shadow. | **W3a code landed.** Highest-traffic entity — soak window owns this risk. |
| Line item (normalized) | `normalized_line_items` | `normalized_line_items` | **Postgres** | Mongo: only `scripts/backfill-mongo-to-supabase.ts`. PG: `lib/supabase-job-search.ts` joins on this for partNumber / labor breakouts. | `ingestLineItem` writes PG canonical first, Mongo shadow after — same polarity as the other five entities. The live work-order ingestion path doesn't yet *call* `ingestLineItem` (only `ingestWorkOrderTree` and `extractLineItemsFromExisting` do); the Tekmetric / Protractor / Shop-Ware adapters embed `lines[]` inside service jobs. | **Polarity flipped (task #344). Decision: keep the PG table.** Wiring `ingestLineItem` into the live single-WO ingestion path (`extractLineItemsFromServiceJob` in each adapter) is a separate W3a-followup, but the per-row write path itself is now PG-first. **Do not drop the table** — it powers the existing PG join. |
| Payment (normalized) | `normalized_payments` | `normalized_payments` | **Postgres** | Mongo: `scripts/verify-normalized-data.ts`. PG: none today. | PG canonical via `ingestPayment` (Tekmetric only — Protractor / Shop-Ware adapters do not yet emit payments); Mongo shadow. | **W3a code landed.** Low blast radius. |

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
| `shop_users` | Mongo | `app/api/platform-admin/tickets/route.ts` | (writes via `users`) | Re-verified 2026-05-03 (task #341): live reader still joins on this for ticket-notification routing. Reclassified **W4** (joined to `users`/`tickets`). |
| `enterprise_accounts` | Mongo | `lib/enterprise.ts`, `app/api/enterprise/{billing,users}/route.ts` | `app/api/enterprise/{billing,mappings}/route.ts` | **W4** (joined to shops). |
| `platform_admins` | Mongo | `lib/super-admins.ts`, `app/api/platform-admin/**` | `scripts/seed-platform-admin.ts`, `scripts/set-platform-admin.ts` | **W4.** |
| `platform_settings` | Mongo | `lib/stripe.ts`, `app/api/platform-admin/{billing,settings}/route.ts` | `lib/stripe.ts`, `app/api/platform-admin/settings/route.ts`, `app/api/admin/billing/settings/route.ts` | **W3.** |
| `platform_plans` | Mongo | `app/api/stripe/plans/route.ts` | `app/api/platform-admin/plans/seed/route.ts` | **W2.** Small, rarely written. |
| `platform_features` | Mongo (canonical), PG twin exists | `lib/featureResolver.ts`, `app/api/features/route.ts`, `app/api/stripe/plans/route.ts`, `app/api/platform-admin/features/route.ts` | `app/api/platform-admin/features/{,seed,reorder}/route.ts` | **Cross-DB conflict** — see §5. |
| `shop_features` | Mongo | `lib/features.ts` | `lib/features.ts` | **W3.** Per-shop feature overrides. |
| `pending_signups`, `setup_tokens`, `password_reset_tokens`, `password_resets` | Mongo | auth flows | auth flows | **W3** (auth-adjacent). `password_resets` re-verified 2026-05-03 (task #341): empty in prod but `app/api/admin/db-indexes/route.ts` still ensures `token` unique + `expiresAt` TTL indexes on it, so it can't be dropped without first retiring those index ensures. Stays **W3**. |

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
| `LKP_VIN_MAINTENANCE`, `LKP_YMM_MAINTENANCE`, `DEF_MAINTENANCE_EVENT`, `serviceevents`, `vehicleschedules`, `inspectionfindings`, `analyses`, `oeschedules` | only `_archive/**` | only `_archive/**` | **DROPPED 2026-05-03** (task #341). Re-grep confirmed only docs/_archive references; production cluster verified absent (already gone, likely from original DataOne retirement). |
| `services_by_ymm` | `routes/maintenance.js`, `routes/vin-maintenance.js`, `routes/vin-next-due.js` (legacy Express server) | (none in repo) | Re-verified 2026-05-03 (task #341): *not* an orphan — `server.js` mounts these Express routers. Reclassified **W2** (retire the legacy Express server first, then drop). Production collection currently absent. |
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
| `job_index` | `lib/job-index.ts`, `lib/tekmetric-job-index.ts`, `lib/integrations/protractor.ts`, `scripts/job-match-calibration.ts` (no longer read by the job-search routes — see task #299) | `lib/normalized-ingestion.ts` (`writeToJobIndex`), `scripts/protractor-job-index-catchup.ts`, `scripts/tekmetric-history-backfill.ts` | Was one of the three triple-source job-search arms; the job-search routes now read PG only (task #299, step 5). The collection is still written by `writeToJobIndex` and read by `lib/job-index.ts` / `lib/tekmetric-job-index.ts` / calibration scripts. **Next step:** confirm those remaining readers can move to PG, then stop `writeToJobIndex` and drop the collection. **BLOCKED** on the same `normalized_service_jobs` PG-canonical cutover. |
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
| `tickets` | `app/api/vehicles/[vin]/refresh/route.ts:67` | `lib/integrations/dvi.ts:282` | Re-verified 2026-05-03 (task #341): *not* an orphan — DVI integration writes RO-tracking docs here keyed by VIN, and the vehicle-refresh route reads them. Distinct from PG `support_tickets`. Production has 1 doc. Reclassified **W3** (active integration data). |
| `events` | `lib/evidence.ts` reads, `lib/integrations/{tekmetric,protractor}/adapter.ts` writes | same | Audit timeline used by VHI / evidence. **W3.** |
| `webhook_events` | only `_archive/**` | only `_archive/**` | **DROPPED 2026-05-03** (task #341). Re-grep clean, production cluster verified absent. |
| `workflow_runs` | `app/api/workflows/runs/route.ts` only | (no writer found in app code) | Re-verified 2026-05-03 (task #341): *not* an orphan — live reader returns workflow runs in the dashboard. No in-repo writer found, but external writer presumed (open-question §7 #4). Reclassified **W2** (drop blocked on confirming external writers). Production collection currently absent. |
| `ratelimits` | `lib/rate.ts` | same | **W1.** Could be Redis instead of PG. |
| `counters` | `lib/ids.ts`, `app/api/platform-admin/shops/route.ts`, `app/api/enterprise/shops/route.ts` | same | ID generation. **W3** — needs an atomic increment story in PG (`SERIAL`/sequence). |
| `sticker_generations`, `sticker_qr_scans`, `shop_media` | sticker routes | sticker routes | **W2.** |

---

## 4. Orphans (drop candidates)

### 4.1 Mongo collections with no live readers in `app/`, `lib/`, or `scripts/` (only `_archive/` references)

Wave 0 cleanup ran 2026-05-03 (task #341). Status per collection:

- `webhook_events` — **DROPPED 2026-05-03** (production cluster verified absent at snapshot time).
- `oeschedules` — **DROPPED 2026-05-03** (verified absent).
- `vehicleschedules` — **DROPPED 2026-05-03** (verified absent).
- `serviceevents` — **DROPPED 2026-05-03** (verified absent).
- `inspectionfindings` — **DROPPED 2026-05-03** (re-grep confirmed `lib/integrations/dvi.ts` only writes `tickets`, not `inspectionfindings`; production verified absent).
- `analyses` — **DROPPED 2026-05-03** (verified absent).
- `LKP_VIN_MAINTENANCE` — **DROPPED 2026-05-03** (uppercase Mongo variant; script references are CSV/Postgres only; production verified absent).
- `LKP_YMM_MAINTENANCE` — **DROPPED 2026-05-03** (verified absent).
- `DEF_MAINTENANCE_EVENT` — **DROPPED 2026-05-03** (verified absent).
- `services_by_ymm` — **RECLASSIFIED → W2 (2026-05-03)**: `routes/{maintenance,vin-maintenance,vin-next-due}.js` (mounted by `server.js`) still read this. Retire the legacy Express server before dropping. Production collection currently absent.
- `password_resets` — **RECLASSIFIED → W3 (2026-05-03)**: `app/api/admin/db-indexes/route.ts` still ensures `token` unique + `expiresAt` TTL indexes. Production collection currently empty (count=0). Drop after retiring the index-ensure caller.

### 4.2 Likely orphans (verify before dropping)

- `shop_users` — **RECLASSIFIED → W4 (2026-05-03, task #341)**: live reader `app/api/platform-admin/tickets/route.ts:315` joins on this. Drop after `tickets`/`users` migrate.
- `workflow_runs` — **RECLASSIFIED → W2 (2026-05-03, task #341)**: live reader exists; no in-repo writer. Drop blocked on confirming external writers (open-question §7 #4). Production currently absent.
- `tickets` — **RECLASSIFIED → W3 (2026-05-03, task #341)**: live writer in `lib/integrations/dvi.ts:282`, live reader in `app/api/vehicles/[vin]/refresh/route.ts:67`. Distinct from PG `support_tickets`. Production has 1 doc.
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
| 3 | `app/api/jobs/search/route.ts` & `app/api/extension/jobs/search/route.ts` | reads `shops` for tenancy/enterprise scoping; (Mongo `job_index` and Mongo `normalized_*` arms retired in task #299, step 5) | reads `normalized_service_jobs` (PG) via `lib/supabase-job-search.ts` | **Was** a triple-source fan-out; collapsed to PG-only on the read side. The cross-DB risk is now narrower: only the `shops` tenancy lookup remains on Mongo. **Open follow-up:** confirm PG mirror parity for `normalized_service_jobs` is acceptable in production — if shops report missing historical jobs after this cutover ships, re-run `scripts/backfill-mongo-to-supabase.ts` for service jobs before declaring victory. |
| 4 | `app/api/extension/jobs/search/route.ts` (vehicle context) | reads `tekmetric_work_orders`, `tekmetric_repair_orders` | (none) | Only blocks extension job search if those collections move. **W3** ordering: keep these on Mongo until the rest of the extension flow is on PG. |
| 5 | `lib/featureResolver.ts` | (was) reads `platform_features` | PG `platform_features` written by `app/api/platform-admin/features/**` | **RESOLVED 2026-05-04 (task #344, W3a):** runtime now reads PG via Drizzle in `getPlanFeaturesFromDatabase`. Admin edits take effect immediately on the next request. Mongo `platform_features` is no longer read by application code; the collection is a candidate for Wave 0-style drop in a follow-up task. The Mongo `getDb` is still used for `shops` / `enterprise_accounts` lookups in the same file — those move in Wave 4. |
| 6 | `lib/external-api/api-keys.ts` (Mongo `api_usage_logs`) **vs.** `lib/db/repositories/call-logs.ts` (PG `apiUsageLogs`) | Mongo `api_usage_logs` — partner-API key usage tracking | PG `api_usage_logs` — call-center / Rescue Rover per-call usage (separate domain) | **RECLASSIFIED 2026-05-04 (task #344): not a real cross-DB conflict — naming collision between two unrelated domains.** The Mongo `api_usage_logs` is written/read by `lib/api-usage-tracker.ts` + `lib/external-api/api-keys.ts` for partner-integration tracking. The PG `api_usage_logs` table is owned by the rescue-rover schema (see §1 last row + §EXCLUDED) and is written exclusively by `lib/db/repositories/call-logs.ts` with a different row shape. No code path writes both. Resolution: rename the PG table in a future Rescue Rover refactor (e.g. `rescue_rover_call_usage`) so the collision goes away; nothing migrates. |
| 7 | `app/api/support/tickets/**` | (was) Mongo `support_tickets` canonical, PG `support_tickets` best-effort dual-write | PG `support_tickets` is now canonical for new ticket inserts | **CODE FLIPPED 2026-05-04 (task #344, W3a):** the `POST /api/support/tickets` handler now writes PG **first** with await + throw on failure; the Mongo insert continues for the duration of the soak so the existing readers (`lib/data/repositories/support-tickets.ts` and the Mongo `aggregate` in `app/api/platform-admin/client-health/route.ts`) keep working. **Operator follow-ups (own task):** rewrite the read-side repo against Drizzle (the Mongo repo's `$set`/`$push`/`aggregate`/regex `$or` surface is still in use by the platform-admin tickets routes), backfill historical Mongo tickets into PG, then delete the Mongo write. PG schema is already in place (`lib/db/schema/support-tickets.ts`). |
| 8 | `app/api/stripe/webhook/route.ts` | writes `users`, `shops`, `pending_signups`, `audit_logs`, `stripe_webhook_events` | (none today) | If we move `shops` or `users` first, the Stripe webhook becomes a cross-DB transaction. Keep `shops`/`users` in W4 to avoid this. |
| 9 | `lib/integrations/core/normalized-ingestion.ts` (`dualWriteToSupabase`) | writes Mongo behind `WRITE_MONGO_NORMALIZED` (default ON during soak) | writes PG canonical (await + re-throw) | **RESOLVED 2026-05-04 (task #344, W3a):** polarity flipped. PG write happens first and re-throws on failure; Mongo write is a best-effort shadow gated on the runtime kill-switch. See §10 and §2. |
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

---

## 8. Wave 1 cutover log (task #342, 2026-05-03)

Wave 1 moved 15 reference / leaf collections to Postgres. The schema lives in
`lib/db/schema/wave1.ts`; the SQL migration is `drizzle/0011_wave1_reference_and_leaf.sql`;
all PG-side reads/writes go through `lib/db/repositories/wave1.ts`.

### 8.1 Per-entity status

| Mongo collection                  | PG table                          | Reads     | Writes              |
|-----------------------------------|-----------------------------------|-----------|---------------------|
| `ratelimits`                      | `ratelimits`                      | PG        | PG canonical + Mongo mirror (best-effort) |
| `viewed_vins`                     | `viewed_vins`                     | PG        | PG + Mongo dual-write |
| `sync_metrics`                    | `sync_metrics`                    | PG        | PG + Mongo dual-write |
| `ingestion_errors`                | `ingestion_errors`                | PG        | PG + Mongo dual-write |
| `extension_analytics`             | `extension_analytics`             | PG        | PG + Mongo dual-write |
| `data_quality_reports`            | `data_quality_reports`            | PG        | PG + Mongo dual-write |
| `system_announcements`            | `system_announcements`            | PG        | PG + Mongo dual-write |
| `knowledge_articles`              | `knowledge_articles`              | PG        | PG + Mongo dual-write |
| `dataone_cache`                   | `dataone_cache`                   | PG        | PG + Mongo dual-write |
| `dataone_oe`                      | `dataone_oe`                      | PG        | PG + Mongo dual-write |
| `lkp_ymm_maintenance_interval`    | `lkp_ymm_maintenance_interval`    | PG        | n/a (reference, populated by backfill) |
| `def_maintenance_event`           | `def_maintenance_event`           | PG        | n/a (reference, populated by backfill) |
| `dataone_lkp_squish_maintenance`  | `dataone_lkp_squish_maintenance`  | PG        | n/a (reference, populated by backfill) |
| `part_cross_ref`                  | `part_cross_ref`                  | PG (count + per-key) | PG + Mongo dual-write |
| `sms_historical_work_orders`      | `sms_historical_work_orders`      | PG (script-only) | PG + Mongo dual-write |

### 8.2 Backfill

`pnpm tsx scripts/wave1-mongo-to-pg-backfill.ts` streams all 15 collections
into the PG mirror tables. Idempotent; safe to re-run. Use `--only=<csv>`
to target a subset and `--batch=<n>` to tune throughput.

The script intentionally uses **separate write helpers** for backfill vs.
the live request path:

- `pgBackfillPartCrossRef` (backfill) **sets** `usageCount` and **replaces**
  the `usedOn` / `workOrderIds` arrays from the source doc; the
  live-write helper `pgUpsertPartCrossRef` increments and merges. This
  prevents re-runs from inflating counts.
- `pgBackfillIngestionError` (backfill) preserves `resolved`,
  `retryCount`, `resolvedAt`, `createdAt`, and `updatedAt` from the
  source doc; the live-write helper `pgUpsertIngestionError` increments
  `retryCount` and forces `resolved=false`. Using the live helper at
  backfill time would resurrect already-resolved errors.

### 8.3 Deferred (W1.5 — operational, not in this PR)

Per-entity 24–48h soak windows and Mongo-write removal are deferred to the
W2 follow-up task already queued. Until then, every dual-write site keeps
the legacy Mongo write best-effort so an emergency rollback to Mongo reads
can be done with a one-line revert at each repo entry point.

### 8.4 Parity report (read-cutover audit artifact)

`pnpm tsx scripts/wave1-parity-report.ts` captures per-entity row counts
(Mongo vs PG) and a small spot-sample diff (sample size configurable via
`--sample=N`, default 10). Output:

- `docs/db-migration-audit-log/wave1-parity-<ISO>.json` — full per-entity
  report with `mongoCount`, `pgCount`, `countDelta`, `missingFromPg`,
  `missingFromMongo`.
- `docs/db-migration-audit-log/wave1-parity.log` — one-line-per-entity
  summary appended on every run, so the audit trail accumulates in repo.

Use `--only=<csv>` to scope to a subset (same flag as the backfill
script). Run this before each entity's read-cutover sign-off and after
any backfill re-run.

#### 8.4.1 Latest dev parity result (2026-05-03T23:40:48Z)

After running the backfill against the dev Mongo + Postgres pair:

| Entity                              | Mongo raw | PG rows | Mongo distinct (PG unique key) |
|-------------------------------------|-----------|---------|--------------------------------|
| `ratelimits`                        | 0         | 0       | 0                              |
| `viewed_vins`                       | 635       | 635     | 635                            |
| `sync_metrics`                      | 0         | 0       | 0                              |
| `ingestion_errors`                  | 0         | 0       | 0                              |
| `extension_analytics`               | 249       | 249     | 249                            |
| `data_quality_reports`              | 603       | 603     | 603                            |
| `system_announcements`              | 0         | 0       | 0                              |
| `knowledge_articles`                | 52        | 52      | 52                             |
| `dataone_cache`                     | 23586     | 23565   | 23565 (21 dup-`squish` docs)   |
| `dataone_oe`                        | 0         | 0       | 0                              |
| `lkp_ymm_maintenance_interval`     | 0         | 0       | 0                              |
| `def_maintenance_event`            | 0         | 0       | 0                              |
| `dataone_lkp_squish_maintenance`   | 0         | 0       | 0                              |
| `part_cross_ref`                    | 109637    | 109359  | 109359 (278 dup-(shopId,normalizedPartNumber) docs) |
| `sms_historical_work_orders`        | 26014     | 26014   | 26014                          |

PG row counts equal the **Mongo distinct count** for every entity that
has data, including the two collections (`dataone_cache`, `part_cross_ref`)
where PG's unique constraint collapses Mongo duplicate-key documents.
The raw artifact is
`docs/db-migration-audit-log/wave1-parity-2026-05-03T23-40-48-991Z.json`
(re-confirmed in `…2026-05-03T23-53-35-232Z.json` after the round-5b
write-path hardening flip — counts unchanged) and the appended summary
lives in `docs/db-migration-audit-log/wave1-parity.log`.

#### 8.4.2 Backfill idempotency

Because `sync_metrics`, `extension_analytics`, `data_quality_reports`,
and `lkp_ymm_maintenance_interval` have no natural unique key, the
backfill stamps each Mongo `_id` into a `backfill_mongo_id text` column
with a unique index (added by `drizzle/0011_…`) and uses
`INSERT … ON CONFLICT (backfill_mongo_id) DO UPDATE` so re-runs do not
double-insert. All other entities are upsert-by-natural-key. Re-running
the backfill end-to-end against dev produced **identical** PG row counts
(verified by running the small-entity backfill twice — counts unchanged).

#### 8.4.3 What "PG canonical" means today

For Wave 1, "PG canonical" means **all reads have moved to Postgres** and
**every write path awaits Postgres first and surfaces PG failures to the
caller** (no try/catch swallows the PG write). Mongo writes are issued
afterwards as a best-effort legacy mirror inside a try/catch that only
logs failures, so a Mongo outage cannot block traffic but a PG outage
will fail the request — which is the desired semantics now that PG is
the source of truth. The Mongo mirror is retained only so a one-line
revert can flip reads back if a regression is found during the W1.5
soak window; it is removed after the per-entity 24–48h soak passes (W2
follow-up — **not** in this PR).

### 8.5 Rate limiter failure mode

`lib/rate.ts` is **fail-closed**: if both the PG counter and the Mongo
fallback throw, `rateLimit()` returns `{ allowed: false }` rather than
allowing the request. This preserves abuse resistance for auth/throttle
protection at the cost of a transient outage when both stores are down.
A risk-tiered "fail-open for low-risk endpoints" policy can be added
later as an explicit per-call option.

---

## 9. Wave 2 schema landing (task #343, 2026-05-04)

**Schema-only PR.** This task lays down the Postgres destination tables
for every Wave 2 entity from §3.3 (W2 rows), §3.4 (W2 rows), §3.5
(W2 rows), §3.7 (non-`api_keys`), and §3.8 (W2 rows), plus the explicit
"Notable members" enumeration from `task-343.md`. **No reads have been
switched and no Mongo writes removed.** Each sub-group cutover ships as
its own follow-up task that uses these tables as the destination.

The schema lives in `lib/db/schema/wave2.ts`; the SQL migration is
`drizzle/0012_wave2_operational.sql`; the backfill script is
`scripts/wave2-mongo-to-pg-backfill.ts` (skeleton — not wired into any
cron yet, each sub-group cutover task runs it with `--only=<csv>`).

### 9.1 Entities by sub-group

| Sub-group       | Entities (Mongo collection → PG table is 1:1 unless noted) |
|-----------------|------------------------------------------------------------|
| `ai-caches`     | `ai_analysis_cache`, `maintenance_analysis_cache`, `ai_budget_alerts`, `vhi_analysis_log`, `concern_conversations`, `report_approved_items`, `remedied_deferred_work`, `shop_repair_patterns`, `oem_schedules`, `oem_carfax_mappings` |
| `external-api`  | `external_api_appointments`, `external_api_keytags`, `external_api_stickers`, `sticker_generations`, `sticker_qr_scans`, `shop_media` |
| `audit-notif`   | `audit_logs`, `admin_audit_logs`, `notifications`, `dashboard_updates` (canonicalized on a single `key` PK), `support_chat_sessions` |
| `queues-locks`  | `enrichment_queue`, `extension_prefetch_locks`, `auto_booking_queue`. **`tekmetric_drain_lock` has no destination table** — it ports to `pg_try_advisory_lock(<int8>)` at cutover time. |
| `tekmetric-op`  | `tekmetric_backfill_progress`, `tekmetric_backfill_health_alerts`, `tekmetric_permfailed_ro_alerts`, `tekmetric_skipped_ro_archive`, `tekmetric_catchup_runs`, `tekmetric_mileage_backfill_progress`, `tekmetric_webhook_logs`, `tekmetric_webhook_subscriptions`, `tekmetric_webhook_health_alerts` |
| `misc`          | `platform_plans` |

### 9.2 Schema conventions (carried over from W1)

- **Natural key as PK** wherever the Mongo collection has one: `(shop_id, vin)`
  for cache tables, `slug` for `platform_plans`, `tekmetric_shop_id` for
  per-Tekmetric-shop state, etc.
- **`backfill_mongo_id text UNIQUE` for append-only collections without a
  natural key** (`vhi_analysis_log`, `audit_logs`, `admin_audit_logs`,
  `tekmetric_skipped_ro_archive`, `tekmetric_catchup_runs`,
  `tekmetric_webhook_logs`, all `external_api_*`, `sticker_generations`,
  `sticker_qr_scans`, `shop_repair_patterns`). Ensures the backfill is
  idempotent on re-run.
- **`id text PK` mirroring the Mongo ObjectId hex** for entities whose
  callers pass the id back in URLs / payloads (`notifications` —
  `/api/notifications/[id]`; `concern_conversations` —
  `conversationId`; `auto_booking_queue` — `replacesBookingId`).
- **`jsonb` for genuinely heterogeneous Mongo shapes**: queue payloads,
  audit details, webhook payloads, dashboard updates, repair-pattern
  metadata. Indexed fields are pulled out as columns, the rest stays in
  `data` / `payload` / `extra` / `raw`.
- **`dashboard_updates` is canonicalized** on a single `key text PK`
  because Mongo splits writers between `_id="lastUpdate"` (global
  heartbeat) and `{shopId}` (per-shop heartbeat). The PG table uses
  `key='lastUpdate'` for the global doc and `key='shop:<id>'` for
  per-shop docs; the cutover PR rewrites both writers to a repository
  helper that picks the right key.

### 9.3 Cutover sub-group ordering (recommended)

Each sub-group is its own follow-up task. The recommended order optimizes
for risk (lowest first) and writer overlap:

1. **`tekmetric-op`** — single-writer (Tekmetric crons), no user-facing
   read path, lowest blast radius. Safe to ship first as the W2 pattern
   shake-out.
2. **`ai-caches`** — pure caches, rebuild-on-miss is allowed, **no soak
   window required**. Backfill is optional. Can ship in parallel with
   `tekmetric-op` since there is no writer overlap.
3. **`external-api`** — self-contained, single writer per route. Append-only.
4. **`audit-notif`** — append-only logs + per-user inbox. `dashboard_updates`
   needs the canonical-key rewrite called out in §9.2.
5. **`queues-locks`** — last because the cutover can also adopt
   `SELECT … FOR UPDATE SKIP LOCKED` for `enrichment_queue` /
   `auto_booking_queue` and the `pg_try_advisory_lock` port for
   `tekmetric_drain_lock` — both are non-trivial behavioral changes,
   not pure mirrors.
6. **`misc`** (`platform_plans`) — trivial, can be folded into whichever
   sub-group ships next.

### 9.4 What this PR does **not** do

- Does **not** switch any reads to PG.
- Does **not** remove or modify any Mongo writes.
- Does **not** wire `scripts/wave2-mongo-to-pg-backfill.ts` into any
  cron or CI; nothing in production calls it yet.
- Does **not** introduce a `lib/db/repositories/wave2.ts` repository
  layer. That ships per sub-group, alongside the read-cutover, so each
  sub-group PR is small and revertible.
- Does **not** port `tekmetric_drain_lock` to a PG advisory lock —
  that change goes with the `queues-locks` cutover.
- Does **not** include a parity report script. The W1 pattern
  (`scripts/wave1-parity-report.ts`) will be cloned per sub-group when
  that sub-group's cutover task starts.

---

## 10. Wave 3a polarity-flip log (task #344, 2026-05-04)

**Code-only PR.** This wave flips the source of truth for the six
normalized entities from Mongo to Postgres in
`lib/integrations/core/normalized-ingestion.ts`, fixes the long-standing
Protractor `vehicle_id` NOT-NULL crash, and resolves the `platform_features`
runtime drift bug. Real backfill, the per-entity soak windows, and the
eventual deletion of `lib/supabase-dual-writer.ts` are operator follow-ups
explicitly enumerated below.

### 10.1 Per-entity status

| Entity                | PG canonical | Mongo shadow (gated) | Mongo readers still live | Notes |
|-----------------------|--------------|----------------------|--------------------------|-------|
| `normalized_vehicles`     | yes | yes (`WRITE_MONGO_NORMALIZED!='0'`) | yes (see §2) | unchanged shape |
| `normalized_customers`    | yes | yes | yes | unchanged shape |
| `normalized_work_orders`  | yes | yes | yes | `vehicle_id` / `vehicle` nullable now (drizzle/0013_*) |
| `normalized_service_jobs` | yes | yes | yes | embedded inside `ingestWorkOrder` |
| `normalized_payments`     | yes | yes | yes | Tekmetric only emits payments today |
| `normalized_line_items`   | yes (`ingestLineItem` flipped) | yes | n/a | per-row polarity flipped; live single-WO path doesn't yet call `ingestLineItem` — adapter wiring deferred (see §10.3 #4) |

### 10.2 What changed in code

1. **Polarity flip** — `NormalizedIngestionService.dualWriteToSupabase`
   now awaits the PG write and **re-throws** on failure (the rich
   `pgCode` / `pgConstraint` / `pgDetail` log line is preserved before
   the rethrow, so on-call still gets the structured diagnostic).
   All six `ingestX` methods (vehicle, customer, work_order,
   service_job, **line_item**, payment) × two paths each (existing +
   new) were reordered so PG writes happen before Mongo, and the
   corresponding Mongo `insertOne` / `updateOne` calls (plus
   `_stampIngestionVia`) are now wrapped in
   `shadowWriteMongo(...)`. Failures from `shadowWriteMongo` are logged
   but never thrown — Mongo is no longer canonical, so a transient
   Mongo outage cannot break ingestion.

   **Pre-existing init bug fixed in the same change**: the
   `NormalizedIngestionService` constructor used
   `require('./db/drizzle')`, which from `lib/integrations/core/`
   resolves to a non-existent `lib/integrations/core/db/drizzle`. Every
   construction silently fell into the catch and left
   `supabaseDualWriter` null — so under the old "best-effort PG"
   semantics, the PG mirror quietly never happened in production. The
   `dualWriteToSupabase` swallow-on-error masked the breakage. After
   the polarity flip this would crash every ingest, so the require
   path is corrected to `'../../db/drizzle'` to match how every other
   PG-using module imports the Drizzle client.
2. **Kill switch** — `lib/integrations/core/normalized-write-mode.ts`
   exports `shouldShadowWriteMongo()` which reads
   `process.env.WRITE_MONGO_NORMALIZED` on every write. Default is ON
   (anything other than the literal string `"0"` keeps shadow writes
   alive). Operators flip it to `"0"` after the per-entity soak passes;
   no deploy is required to halt or resume the Mongo mirror.
3. **Protractor `vehicle_id` fix** — `lib/db/schema/normalized.ts`
   drops `.notNull()` from `normalized_work_orders.vehicleId` and
   `.vehicle`; `drizzle/0013_relax_normalized_work_order_vehicle.sql`
   carries the `ALTER COLUMN … DROP NOT NULL` for both columns. The
   defensive early-return block in
   `lib/supabase-dual-writer.ts:upsertWorkOrder` (which silently
   skipped Protractor invoices missing `vehicleId` / `vehicle`) is
   removed; rows with a blank work order number now fall back to
   `String(doc._id)` so they land and can be diagnosed downstream
   instead of being dropped on the floor.
4. **`platform_features` runtime cutover (§5 row #5)** —
   `lib/featureResolver.ts:getPlanFeaturesFromDatabase` now reads
   `platform_features` from PG via Drizzle. Admin edits in
   `app/api/platform-admin/features/**` already wrote PG; before this
   change the runtime read Mongo and admin edits silently failed to
   take effect. `__deps` test seam now exposes both `getDb` (Mongo,
   still used for `shops` / `enterprise_accounts` lookups in the same
   file) and `getPgDb`.

### 10.3 What this PR does **not** do — operator follow-ups

The W3a code-flip is **necessary but not sufficient** to retire Mongo
for these entities. The remaining work is operational and must be
sequenced by an operator with production cluster access; none of it
can be executed in an isolated task environment. Each item below
should be its own follow-up task.

1. **Backfill** — re-run
   `pnpm tsx scripts/backfill-mongo-to-supabase.ts` end-to-end against
   production for the six entities (`vehicles`, `customers`,
   `work_orders`, `service_jobs`, `line_items`, `payments`). The
   `normalized_line_items` table is included so the
   `lib/supabase-job-search.ts` join keeps producing rows for
   historical work orders.
2. **Per-entity soak window (24–168 h)** — leave
   `WRITE_MONGO_NORMALIZED` ON, watch the `[PgCanonical]` /
   `[ShadowMongo]` log channels and a per-entity success/failure
   metric. Sign off each entity individually, just like Wave 1
   (§8.4.1).
3. **Move Mongo readers to PG** — every reader still on Mongo
   (enumerated per-entity in §2) must move to PG-via-Drizzle before
   the operator sets `WRITE_MONGO_NORMALIZED=0`, otherwise readers
   will go stale the moment shadow writes stop. The `ingestX`
   methods themselves still read from Mongo for change-detection
   (`existing = await collection.findOne(...)`) — that read also
   needs to move to PG before shadow writes stop, or change-detection
   silently degrades to "always update".
4. **Wire `upsertLineItem` / `upsertPayment` into live ingestion** —
   adapter-level work (`extractLineItemsFromServiceJob`) so that the
   PG `normalized_line_items` join in `supabase-job-search.ts`
   returns rows for new data, not just backfilled history. This is
   the line-item decision recorded in §2: **keep the PG table, defer
   the wiring**.
5. **Retire `lib/supabase-dual-writer.ts`** — once every entity has
   passed soak and `WRITE_MONGO_NORMALIZED=0` is the production
   setting, rename `lib/supabase-dual-writer.ts` to a more honest name
   (e.g. `lib/normalized-pg-writer.ts`) and delete its dead
   `serializeProvenance` / `sanitizeForJson` Mongo-shape adapters that
   exist only because the input was a Mongo-shaped doc.
6. **Drop the `normalized_*` Mongo collections** — last, after the
   readers in (3) are migrated and the soak in (2) passes. Use the
   Wave 0 procedure (verify production absent, snapshot, drop).
7. **§5 row #6 — `api_usage_logs`** — separate task. Needs
   (a) a Drizzle repository for the existing PG `api_usage_logs`
   table, (b) a backfill of historical Mongo logs, and (c) the
   shape-divergence audit between the Mongo and PG records before one
   can be declared canonical.
8. **§5 row #7 — `support_tickets`** — separate task. Needs the full
   `lib/data/repositories/support-tickets.ts` rewritten against
   Drizzle (Mongo `$set`/`$push`/`aggregate`/regex `$or` translated
   to SQL), 8 route handlers updated, ticket backfill, and per-route
   soak. PG schema is already in place
   (`lib/db/schema/support-tickets.ts`).

### 10.4 Code review iteration 2 — additional items

After the first code review pass flagged scope gaps, the following were added to the W3a code-flip PR:

- **Line items (`ingestLineItem`)**: missed in the first pass; now flipped to PG-canonical-first with `shadowWriteMongo` gate, same pattern as the other five entities.
- **Constructor init bug**: the long-standing `require('./db/drizzle')` typo (resolved to a non-existent `lib/integrations/core/db/drizzle`) was silently leaving the PG writer null. Pre-existing, but harmless under the swallow-on-error semantics; with the polarity flip it would have crashed every ingest. Corrected to `require('../../db/drizzle')`.
- **`support_tickets` POST polarity**: `app/api/support/tickets/route.ts` now writes PG first with await + throw. Mongo write retained for read-side parity until the read-side repo is migrated.
- **`api_usage_logs` reclassification**: confirmed naming collision between two unrelated domains (partner API keys in Mongo vs. Rescue Rover call usage in PG); not a real cross-DB conflict, no migration needed. §5 row #6 updated accordingly.
- **Dual-writer file rename intent**: `lib/supabase-dual-writer.ts` now carries a header documenting that it is the PG-canonical writer for the six normalized entities (not a dual-writer) and that the rename to `lib/normalized-pg-writer.ts` ships in the W3a-followup so the polarity-flip diff stays reviewable.

### 10.5 Items that physically require operator access (cannot complete in an isolated task env)

The following items remain open by definition because they require either production cluster access, a multi-day soak window, or a backfill that this isolated task environment cannot perform. They are tracked as the W3a-followup task and must be completed before W3a is declared production-final:

1. Run `scripts/backfill-mongo-to-supabase.ts` end-to-end against production for the six entities + line items.
2. Per-entity 24–168 h soak with `WRITE_MONGO_NORMALIZED=1`; sign off each entity before flipping to `"0"`.
3. Migrate Mongo readers (enumerated per-entity in §2) and the change-detection `findOne` in `ingestX` methods to PG-via-Drizzle.
4. Wire `extractLineItemsFromServiceJob` in each adapter so `ingestLineItem` is called from the live single-WO path, not just from backfill.
5. Rename `lib/supabase-dual-writer.ts` → `lib/normalized-pg-writer.ts` (class + import sites) and strip the dead Mongo-shape adapters once Mongo writes are off.
6. Drop the `normalized_*` Mongo collections (Wave 0 procedure: verify production absent, snapshot, drop).
7. Migrate the read-side `support_tickets` repo (`lib/data/repositories/support-tickets.ts` + `app/api/platform-admin/client-health/route.ts`) to Drizzle queries against `supportTickets`, backfill historical Mongo tickets, then remove the Mongo write from `POST /api/support/tickets`.
