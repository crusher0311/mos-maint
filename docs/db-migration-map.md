# Database Migration Map (MongoDB → Supabase Postgres)

**Status:** living document. Update as cutover waves complete.
**Scope:** all persisted entities except CRM and Rescue Rover (being removed in a separate back-out task — see those tables marked **EXCLUDED**).
**Sources:** walked `lib/db/schema/` (Postgres / Drizzle), every `db.collection(...)` call site (Mongo), `lib/supabase-dual-writer.ts`, `lib/normalized-ingestion.ts`, and the cron / webhook entry points listed in task #296.
**Companion script:** `scripts/backfill-mongo-to-supabase.ts` is the only end-to-end Mongo→PG backfill tool today and only handles the 6 normalized collections.

**Final decommission status (2026-05-04, task #347): BLOCKED.** The pre-decommission audit (Step 1) found 487 files in the live tree still importing `mongodb` / `mongoose` or holding a Mongo handle (319 in `app/`, 112 in `lib/`, 50 in `scripts/`, 3 in `tests/`). W3a is still in soak with `WRITE_MONGO_NORMALIZED=1`; W4 only landed schema and central-lib gating with `IDENTITY_PG_CANONICAL=0` / `WRITE_MONGO_IDENTITY=1`; W2/W3 raw mirrors and the cron distributed lock are still Mongo-canonical at runtime. Per the task's own architectural constraint ("If any step uncovers a Mongo dependency that was missed, abort the decommission"), no destructive action was taken — `lib/mongo.ts`, `lib/supabase-dual-writer.ts`, the `mongodb`/`mongoose` packages, the `MONGODB_*` env vars, and every Atlas collection are untouched. Audit + resume checklist: `docs/audits/2026-05-04-task-347-decommission-aborted.md`.

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
setting it to `"0"`).

**W3a-followup (task #552) — COMPLETE in code.** The three remaining live
Mongo readers were moved to Postgres:
`app/api/estimate-assist/job-builder/route.ts` (VIN lookup),
`lib/estimate-assist/job-knowledge-base.ts` `getShopHistoricalAverage`
(shop-historical aggregate), and `scripts/repair-patterns-from-jobindex.ts`
(VIN→mileage lookup; it still reads `job_index` from Mongo, which is a
separate §3.6 store, not one of the six normalized entities). The remaining
Mongo readers are intentionally retained: the parity verifier
(`scripts/verify-normalized-data.ts`, must compare both DBs), the backfill
source (`scripts/backfill-mongo-to-supabase.ts`), diagnostic/repair scripts,
admin observability routes, and `data-v2` (not on the live frontend path).

**✅ RESOLVED (task #552) — the in-ingestion change-detection reads are now
PG-canonical.** Each `ingestX` method in
`lib/integrations/core/normalized-ingestion.ts` previously did its
"have-I-seen-this-record-before" lookup against **Mongo**
(`existing = await collection.findOne(existingQuery)`). Because the dual-writer's
PG upserts de-dupe only on the surrogate `id` (not a natural key), a post-flip
`findOne` MISS would have taken the "create" branch and either silently inserted
a duplicate or thrown on the `(shopId,vin)` / `(shopId,workOrderNumber)` unique
index. The fix: change-detection now reads PG first via the natural-key finders
on `SupabaseDualWriter` (`findVehicle/Customer/WorkOrder/ServiceJob/LineItem/
PaymentByNaturalKey`), falling back to the Mongo `findOne` **only while shadow
writes are on** (`shouldShadowWriteMongo()`):
`const existing = (dualWriter ? await dualWriter.findXByNaturalKey(...) : null) ?? (shouldShadowWriteMongo() ? await collection.findOne(existingQuery) : null)`.
The finders return a *minimal* projection tagged `__fromPg: true`; the two
task #414 skip-fk-backfill upserts (work_order, service_job) are guarded by
`if (!existing.__fromPg)` so a PG hit never spreads its partial shape over the
real row, while a Mongo-fallback hit (pre-flip doc, PG row missing) still
backfills the parent. Natural keys mirror the old Mongo queries exactly
(`vin`+`shopId` for vehicles; `shopId` + `provenance.sourceIds` containment for
customers/work_orders; parent FK + matching `sourceIds.idValue` for
service_jobs/line_items/payments), so dedupe semantics are unchanged. GIN
indexes (`jsonb_path_ops` on `(provenance -> 'sourceIds')`) back the containment
lookups for all six tables (`drizzle/0017_*`, mirrored idempotently in
`scripts/apply-normalized-migration.ts`). Locked in by
`tests/pg-canonical-fk-skip-path.smoke.ts` (both Mongo-fallback and PG-canonical
skip scenarios). After this change a post-flip ingest finds the existing record
in PG and correctly takes the update/skip branch, so `WRITE_MONGO_NORMALIZED=0`
no longer duplicates or throws.

**Operator action to finish the cutover (cannot be done in an isolated task
env):** run the production
backfill, complete a 24–168 h soak with the parity verifier clean, then set
`WRITE_MONGO_NORMALIZED=0` in the production environment to stop the Mongo shadow
writes. This is a runtime env change only — no deploy required, and it is
reversible by unsetting the flag. Dropping the `normalized_*` Mongo collections is
explicitly **out of scope** for W3a (separate back-out task).

| Entity | Mongo collection | PG table | Source of truth | Read paths | Write paths | Cutover status |
| --- | --- | --- | --- | --- | --- | --- |
| Vehicle (normalized) | `normalized_vehicles` | `normalized_vehicles` | **Postgres** | PG: `lib/supabase-job-search.ts` (job-search), `app/api/estimate-assist/job-builder/route.ts` (VIN lookup, moved to PG in W3a-followup task #552). `lib/integrations/autovitals.ts` reads only `autovitals_*` caches — it never read this collection (the earlier listing was stale). | PG canonical via `ingestVehicle`; Mongo shadow gated on `WRITE_MONGO_NORMALIZED`. | **Live app readers on PG (#552).** Change-detection now PG-canonical (#552) — cutover unblocked; see §2 header. |
| Customer (normalized) | `normalized_customers` | `normalized_customers` | **Postgres** | PG: `lib/supabase-job-search.ts`. Mongo: only `scripts/verify-normalized-data.ts` (parity verifier — must compare both DBs by design). | PG canonical via `ingestCustomer`; Mongo shadow. | **Live app readers on PG (#552).** Change-detection now PG-canonical (#552) — cutover unblocked; see §2 header. |
| Work order (normalized) | `normalized_work_orders` | `normalized_work_orders` | **Postgres** | PG: `lib/supabase-job-search.ts`, `scripts/repair-patterns-from-jobindex.ts` (VIN→mileage lookup, moved to PG in task #552). Mongo readers that remain are intentionally out of scope: parity/diagnostic/backfill scripts, admin observability routes (`admin/normalized-stats`, `admin/sync-health`, `platform-admin/tekmetric/normalized-ingestion-breakdown`), the `tekmetric-backfill` countDocuments, and `app/api/dashboard/data-v2/route.ts` (not wired to the frontend — the live dashboard is `/api/dashboard/data`, which reads integration caches, not normalized). `lib/integrations/autovitals.ts` never read this collection (stale listing). | PG canonical via `ingestWorkOrder` (also embeds service jobs); Mongo shadow. | **Live app readers on PG (#552).** Change-detection now PG-canonical (#552) — cutover unblocked; see §2 header. Protractor non-vehicle invoice crash fixed: `vehicle_id` / `vehicle` are now nullable on `normalized_work_orders` (drizzle/0013_*). |
| Service job (normalized) | `normalized_service_jobs` | `normalized_service_jobs` | **Postgres** | PG: `lib/supabase-job-search.ts` (job-search), `lib/estimate-assist/job-knowledge-base.ts` `getShopHistoricalAverage` (moved to PG in task #552). | PG canonical via embedded write inside `ingestWorkOrder`; Mongo shadow. | **Live app readers on PG (#552).** Change-detection now PG-canonical (#552) — cutover unblocked; see §2 header. Highest-traffic entity — soak window owns this risk. |
| Line item (normalized) | `normalized_line_items` | `normalized_line_items` | **Postgres** | Mongo: only `scripts/backfill-mongo-to-supabase.ts`. PG: `lib/supabase-job-search.ts` joins on this for partNumber / labor breakouts. | `ingestLineItem` writes PG canonical first, Mongo shadow after — same polarity as the other five entities. **It is wired into the live path** (task #360): `ingestWorkOrderWithAllEntities` and `replayServiceJobsAndLineItemsFromRawPayload` both iterate `extractRawServiceJobsFromWorkOrder` → `ingestServiceJob` → `extractLineItemsFromServiceJob` → `ingestLineItem`, and every live entry point (Tekmetric/Protractor webhooks, crons, full-page backfill) routes through `ingestWorkOrder{,Batch}WithAllEntities`. | **`ingestLineItem` wired into live path (#360); keep the PG table** — it powers the existing PG join. Change-detection now PG-canonical (#552) — cutover unblocked; see §2 header. (Earlier "doesn't yet call `ingestLineItem`" note was made obsolete by task #360.) |
| Payment (normalized) | `normalized_payments` | `normalized_payments` | **Postgres** | Mongo: only `scripts/verify-normalized-data.ts` (parity verifier). PG: none today. | PG canonical via `ingestPayment` (Tekmetric only — Protractor / Shop-Ware adapters do not yet emit payments); Mongo shadow. | **Live app readers on PG (#552).** Change-detection now PG-canonical (#552) — cutover unblocked; see §2 header. Low blast radius. |

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

> **W4 status (2026-05-04, task #346): schema-landed, central libs gated.**
> Drizzle schema in `lib/db/schema/wave4.ts`; migration in
> `drizzle/0015_wave4.sql`; PG read/write surface in
> `lib/data/repositories/pg/identity.ts`; kill-switch in
> `lib/db/wave4-write-mode.ts` (`IDENTITY_PG_CANONICAL`,
> `WRITE_MONGO_IDENTITY`, default OFF/ON respectively).
> Central libs **already dispatch** on the flag: `lib/auth.ts`,
> `lib/extension-auth.ts`, `lib/super-admins.ts`, `lib/shops.ts`,
> `lib/featureResolver.ts`, `lib/stripe.ts`. Backfill handled by
> `tsx scripts/backfill-mongo-to-supabase.ts --mirror=all-w4` (16
> mirrors, dependency-ordered). Cutover playbook: `docs/runbooks/db-w4-cutover.md`.
> **Direct callsites that still write Mongo until refactored** (top by
> reference count): `app/api/stripe/webhook` (23),
> `app/api/settings/users/[userId]` (14),
> `app/api/dashboard/enterprise-users` (13),
> `app/api/platform-admin/shops/[shopId]` (12),
> `app/api/auth/login` (8), `app/api/auth/signup` (7),
> `app/api/admin-login` (6), `app/api/auth/reset-password` (5),
> `app/api/billing/portal` (4), `app/api/platform-admin/plans` (4).
> While `WRITE_MONGO_IDENTITY=1` these stay in Mongo and the post-window
> backfill brings PG back in sync.
>
> **W4 status (2026-05-30, task #554): remaining direct-Mongo identity
> writers refactored to dual-write.** Every Mongo identity write below now
> keeps Mongo primary and adds `await dualWritePgIdentity("label", () =>
> pgRepoFn(...))` immediately after (no-op when `IDENTITY_PG_CANONICAL=0`,
> re-throws when `=1`), so PG stays in lockstep without changing default
> behavior. Routes refactored: `app/api/stripe/webhook/route.ts` (all
> `shops`/`users` insert + update sites — signup, CRM provisioning, card
> capture, subscription updated/deleted, payment succeeded/failed,
> trial-conversion failure; the two fire-and-forget `stickerConfig`
> hovercode writes are intentionally **not** mirrored — non-identity sticker
> config, out of scope), `app/api/settings/users/[userId]/route.ts` (PATCH
> update + DELETE), `app/api/enterprise/shops/route.ts` (shop insert, cloned
> user insert, `$unset enterpriseId` clear), `app/api/platform-admin/plans/
> seed/route.ts` (plan upsert). `app/api/stripe/billing-portal/route.ts` was
> a read-only `shops.findOne`, now routed through the flag-aware
> `getShopById` instead of a direct Mongo read. New repo helpers added to
> `lib/data/repositories/pg/identity.ts`: `insertShop`, `updateUserFields`,
> `deleteUserById`, `upsertPlatformPlan` (plus `updateShopFields` extended so
> `enabledFeatures.*` dot-paths write the real `enabled_features` column
> rather than the `settings` catch-all). Out of scope: flipping flags,
> dropping Mongo (downstream "flip PG canonical & retire Mongo shadow" task).
>
> **W4 status (2026-05-30, task #555): cutover is CODE-READY; the production
> flip / soak / shadow-retirement were NOT performed — they are operator-only
> actions and remain OPEN.** Verified from the isolated task env that the
> production cutover has not been run: `IDENTITY_PG_CANONICAL` and
> `WRITE_MONGO_IDENTITY` are unset at runtime and in every config
> (`.env*`, `.replit`, `render.yaml`), so prod is still on the pre-cutover
> defaults (Mongo-canonical, shadow-writes-on); there are no deployment logs
> and zero `pg_miss_mongo_hit`, `[DualWritePgIdentity]`, or
> `[ShadowMongoIdentity]` markers (the runbook's three soak gates), i.e. the
> flag has never been flipped on under traffic. Per the established convention
> (W3a/W3b §10.5/§11.8) and the dev==prod-Mongo constraint, the W4 backfill,
> the `IDENTITY_PG_CANONICAL=1` flip, the 24–168 h soak, and driving
> `pg_miss_mongo_hit` drift to zero **cannot run in an isolated task env** —
> they require production cluster access and a real soak window.
> **The extension-auth Mongo fallback (PG-miss → `users.extensionToken` /
> `extensionTokens[]` read in `lib/extension-auth.ts` and `lib/auth.ts`) was
> therefore deliberately LEFT IN PLACE.** Removing it before a clean soak
> confirms zero drift would strip the net that keeps logged-in users
> authenticated through the flip, and would do so while the flag is still off
> in prod (worst possible ordering). It must only be removed once step 4 of
> the runbook is reached with drift confirmed zero.
>
> **Operator steps remaining to complete W4 (`docs/runbooks/db-w4-cutover.md`):**
> 1. Pre-window backfill + verify: `tsx scripts/backfill-mongo-to-supabase.ts
>    --mirror=all-w4`, confirm `coverage>=99%` for every spec; spot-check
>    `shops` / `users` row counts.
> 2. In the maintenance window: final delta backfill, then set
>    `IDENTITY_PG_CANONICAL=1` (keep `WRITE_MONGO_IDENTITY=1`) and restart.
> 3. Run the auth smoke (login → `/api/auth/me` → switch-shop → password
>    reset → re-login) with a real cookie; if any step 401s, roll back.
> 4. Soak with periodic delta backfills; every W4 mirror must report `OK` and
>    logs must show zero `[DualWritePgIdentity]` / `[ShadowMongoIdentity]`
>    errors and `pg_miss_mongo_hit` drift driven to zero at T+1h/6h/24h.
> 5. `ALTER TABLE users VALIDATE CONSTRAINT users_shop_id_fkey;`.
> 6. After the soak passes: set `WRITE_MONGO_IDENTITY=0`, then (and only then)
>    remove the extension-auth Mongo fallback and flip this status to complete.

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

**Purity progress (task #997, 2026-08-01).** All five integrations now have flag-gated abstracted repos + PG repos: Tekmetric (`lib/data/repositories/tekmetric-work-orders.ts` gated onto new `pg/tekmetric-cache.ts`; extension job-search + report-route reads folded on) and AutoFlow (new gated `autoflow-cache.ts` + `pg/autoflow-cache.ts`; `lib/evidence.ts` DVI read + plan-page `autoflow_events` read folded on) join the existing Protractor/Shop-Ware/AutoVitals ones. The abstracted identity repos (`lib/data/repositories/{sessions,shops,users}.ts`) are gated on `IDENTITY_PG_CANONICAL` onto `pg/identity.ts` (three untranslatable query-shape helpers left Mongo-only, documented in-file). New per-domain parity checker: `scripts/cutover-parity.ts --domain=identity|tekmetric|protractor|shopware|autoflow|autovitals|all` (read-only; counts, freshness, bidirectional sampled key diffs, field spot checks; non-zero exit on >1% count delta or missing sampled keys). Remaining direct Mongo call sites per integration (sync/backfill writers, dashboard/plan-build/vhi aggregates) stay correct under the shadow write and are inventoried in `docs/runbooks/db-integration-cache-cutover.md`.

**Cutover infrastructure (task #556).** The PG mirror tables exist (`drizzle/0014_wave3.sql`, schema in `lib/db/schema/wave3.ts`/`wave2.ts`). Each of the five integrations now has a pair of runtime kill-switches in `lib/db/integration-cache-write-mode.ts`:

* `<INTEGRATION>_CACHE_PG_CANONICAL=1` flips that integration's *abstracted* cache repos from Mongo reads/writes to Postgres. **Default OFF → Mongo canonical → zero behaviour change.**
* `WRITE_MONGO_<INTEGRATION>_CACHE=0` disables the Mongo shadow write during the post-flip soak. **Default ON.**

`<INTEGRATION>` ∈ `{TEKMETRIC, PROTRACTOR, SHOPWARE, AUTOFLOW, AUTOVITALS}`. PG read/write surfaces live in `lib/data/repositories/pg/{shopware,protractor,autovitals}-cache.ts` and are dispatched from the matching Mongo repos. Per-integration backfill + soak + flip is **operator action in prod** (this repl's dev Mongo == prod, so no writes/backfills run here). Full playbook, per-integration readiness, and the remaining direct-access reader call sites (the `lint:direct-db` allowlist) that must be folded onto the gated repos before each flip: **`docs/runbooks/db-integration-cache-cutover.md`**.

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
| `autovitals_vehicles`, `autovitals_inspections`, `autovitals_appointments`, `autovitals_imports` | `lib/integrations/autovitals.ts`, `app/api/autovitals/**` | same | **W3.** Abstracted repos gated on `AUTOVITALS_CACHE_PG_CANONICAL` (#556). **Pre-flip:** `autovitals_appointments`/`autovitals_inspections` still need backfill mirror specs (only `autovitals_vehicles` exists) — see runbook. |

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
| `job_index` | **Live app (read):** `lib/mongo-job-search.ts` (still the active fallback arm in `app/api/jobs/search` + `app/api/extension/jobs/search` — used whenever the PG arm returns nothing), `app/api/plan-build/route.ts` (vehicle service-history secondary source), `app/api/parts/{build-history,search,rebuild,compatible}/route.ts` (parts intelligence), `app/api/jobs/stats/route.ts`, `app/api/dashboard/protractor/job-history/route.ts` (dashboard UI), `app/api/internal/backfill-labor-rates/route.ts`, `app/api/admin/normalized-stats/route.ts`, `lib/integrations/tekmetric/job-index.ts`, `lib/integrations/protractor/client.ts`, `lib/shopware-jobs-prewarm.ts`. **Scripts (read):** `job-match-calibration`, `job-index-aces-coverage`, `repair-patterns-from-jobindex`, `backfill-mongo-to-supabase`, etc. | `lib/normalized-ingestion.ts` (`writeToJobIndex`), the Tekmetric/Protractor/Shop-Ware sync + webhook + cron paths (`lib/integrations/tekmetric/job-index.ts`, `lib/integrations/protractor/sync.ts`, `app/api/webhooks/protractor/[token]`, `app/api/cron/{tekmetric-sync,tekmetric-backfill,tekmetric-ro-retry,protractor-sync,shopware-sync,shopware-backfill}`), `app/api/parts/{search,rebuild,build-history}`, backfill scripts | Was one of the three triple-source job-search arms. **Reader-confirmation re-audit (2026-05-30): the earlier "only read by `lib/job-index.ts` / calibration scripts" claim is WRONG.** `job_index` is still read by the live job-search fallback arm AND by several other live features (plan-build, parts intelligence, dashboard job-history, jobs/stats, labor-rate inference). Per migration map §2, the production Mongo→PG backfill has **not** been run and PG `normalized_service_jobs` is not yet populated with history, so the job-search fallback (and the historical readers) are the *only* source for pre-cutover data. **Retirement is BLOCKED:** stopping `writeToJobIndex` or dropping the collection now would break live job-search history + the parts/plan/dashboard readers, and is a destructive prod operation (dev Mongo == prod Mongo). **Prerequisite (operator action, cannot run in an isolated task env):** run `scripts/backfill-mongo-to-supabase.ts` for service jobs, complete the §2 soak with the parity verifier clean, repoint the live readers above to PG, *then* stop the writers and drop the collection. **BLOCKED** on the §2 `normalized_service_jobs` PG-canonical cutover. |
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
3. **Move Mongo readers to PG.**
   - ✅ **App-level readers DONE (task #552):** the three remaining
     live app readers moved to PG-via-Drizzle —
     `app/api/estimate-assist/job-builder/route.ts` (VIN lookup),
     `lib/estimate-assist/job-knowledge-base.ts`
     `getShopHistoricalAverage`, and the `normalized_work_orders` read
     in `scripts/repair-patterns-from-jobindex.ts`.
   - ✅ **DONE (task #552) — change-detection reads are now PG-canonical
     (this was the real flag-flip blocker).** Every `ingestX` method now
     reads PG first via the `SupabaseDualWriter` natural-key finders
     (`findXByNaturalKey`), falling back to the Mongo `findOne` only while
     `shouldShadowWriteMongo()` is true. The two skip-fk-backfill upserts
     are guarded by `if (!existing.__fromPg)` so a PG hit never clobbers
     the real row with the finder's partial projection. GIN indexes on
     `(provenance -> 'sourceIds')` (`drizzle/0017_*`) back the containment
     lookups. A post-flip ingest now finds the existing record in PG and
     takes the update/skip branch instead of duplicating/throwing. See the
     ✅ block at the top of §2.
4. ✅ **Wire `ingestLineItem` into live ingestion — DONE (task #360).**
   `ingestWorkOrderWithAllEntities` /
   `replayServiceJobsAndLineItemsFromRawPayload` iterate
   `extractRawServiceJobsFromWorkOrder` → `ingestServiceJob` →
   `extractLineItemsFromServiceJob` → `ingestLineItem`, and every live
   entry point routes through `ingestWorkOrder{,Batch}WithAllEntities`,
   so the PG `normalized_line_items` join in `supabase-job-search.ts`
   gets rows for new data, not just backfilled history. (`upsertPayment`
   is likewise wired for Tekmetric; Protractor/Shop-Ware adapters don't
   yet emit payments.)
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
3. ✅ DONE (task #552): App-level Mongo readers (enumerated per-entity in §2) migrated to PG-via-Drizzle, AND the in-ingestion change-detection `findOne` in each `ingestX` method now reads PG first via the `SupabaseDualWriter` natural-key finders (Mongo fallback only while shadow writes are on), backed by `(provenance -> 'sourceIds')` GIN indexes (`drizzle/0017_*`). A post-flip ingest finds the existing record in PG instead of duplicating/throwing — see §10.3 item 3 and the ✅ block in §2. Operator still owns backfill + soak + the `WRITE_MONGO_NORMALIZED=0` flip.
4. ✅ DONE (task #360): `ingestLineItem` is called from the live path via `ingestWorkOrder{,Batch}WithAllEntities` → `extractRawServiceJobsFromWorkOrder` → `extractLineItemsFromServiceJob`, not just from backfill.
5. Rename `lib/supabase-dual-writer.ts` → `lib/normalized-pg-writer.ts` (class + import sites) and strip the dead Mongo-shape adapters once Mongo writes are off.
6. Drop the `normalized_*` Mongo collections (Wave 0 procedure: verify production absent, snapshot, drop).
7. Migrate the read-side `support_tickets` repo (`lib/data/repositories/support-tickets.ts` + `app/api/platform-admin/client-health/route.ts`) to Drizzle queries against `supportTickets`, backfill historical Mongo tickets, then remove the Mongo write from `POST /api/support/tickets`.

## §11 Wave 3b — schema landing + small end-to-end items (2026-05-04)

W3b is split between (a) the small/contained items that can flip end-to-end inside an isolated task environment (`counters`, `api_keys`, `events`) and (b) the wide raw-mirror surface (Tekmetric / Protractor / Shopware / Autoflow / Autovitals + plan caches + pre-normalized layer + carfax / job_index / sms_historical_work_orders) where the schema and backfill scaffolding ships now but per-integration soak + read switch + Mongo retirement is deferred to follow-up tasks per group.

### 11.1 Schema landing — every W3b entity (date 2026-05-04)

`lib/db/schema/wave3.ts` (~1209 lines) defines Drizzle tables for the entire W3b surface and is exported via `lib/db/schema/index.ts`. Drizzle migration mirror is `drizzle/0014_wave3.sql`.

| Group | Tables | Status (2026-05-04) |
| --- | --- | --- |
| Counters | `pg_counters` | **End-to-end** (PG canonical, see §11.2). |
| API keys | `pg_api_keys`, `external_api_usage_logs` | **End-to-end** (PG canonical, Mongo shadow gated, see §11.3). |
| Events | `events` | **End-to-end** for write + most reads (PG canonical, see §11.4). `streamEvents`/`aggregateEvents` deferred. |
| Tekmetric | `tekmetric_tokens`, `tekmetric_api_usage`, `tekmetric_work_orders`, `tekmetric_repair_orders`, `tekmetric_vehicles` | Schema landed. Backfill specs (work_orders / repair_orders / vehicles) wired. `tekmetric_tokens` deferred (encrypted columns; auth-library cutover). |
| Protractor | `protractor_work_orders`, `protractor_invoices`, `protractor_invoice_cache`, `protractor_vehicles`, `protractor_canned_jobs`, `protractor_canned_jobs_cache`, `protractor_ro_cache`, `protractor_template_cache`, `protractor_service_items`, `protractor_deferred_work`, `protractor_callback_events` | Schema landed. Backfill specs for work_orders / invoices / vehicles / callback_events wired. Cache tables (rebuild-on-miss) skip backfill. |
| Shopware | `shopware_repair_orders`, `shopware_vehicles`, `shopware_customers`, `shopware_backfill_progress`, `shopware_webhook_logs` | Schema landed. Backfill specs wired (mosShopId/roId natural keys). |
| Autoflow | `autoflow_credentials`, `autoflow_dvi_items`, `autoflow_events`, `af_open` | Schema landed. Backfill specs for dvi_items / events / af_open wired. `autoflow_credentials` deferred (encrypted columns). |
| Autovitals | `autovitals_vehicles`, `autovitals_appointments`, `autovitals_inspections`, `autovitals_imports` | Schema landed. Backfill specs for vehicles / imports wired. appointments / inspections deferred (~12 indexed domain fields each — needs per-integration extract). |
| Pre-normalized | `pre_normalized_repair_orders`, `pre_normalized_vehicles`, `pre_normalized_customers`, `pre_normalized_manual_vehicles`, `dvi`, `dvi_results`, `canned_jobs`, `canned_job_applications` | Schema landed. Backfill specs wired. **Retirement strategy: prefer migrating readers to `normalized_*` (W3a output) instead of soaking the pre-normalized port.** Per-reader decision table — TODO. |
| Plan caches | `plans`, `plan_cache`, `plan_prefetch_cache`, `recommendations` | Schema landed. Backfill specs for `plans` / `plan_cache` / `recommendations` wired. Caches: rebuild-on-miss is allowed; cutover does not require a long soak. |
| Carfax | `carfax_reports`, `carfax_history`, `carfax_cache` | Schema landed. Backfill specs wired. |
| Job index | `job_index`, `job_history`, `jobs` | Schema landed. Backfill specs wired. |
| SMS history | `sms_historical_work_orders` | Schema landed. Backfill spec wired. |

### 11.2 Counters — PG canonical end-to-end (2026-05-04)

- `pg_counters(name text primary key, seq bigint not null default 0)` is the canonical writer.
- `lib/data/repositories/pg-counters.ts` exposes `nextSeq` / `peekSeq` / `bumpSeq` (atomic `UPDATE … RETURNING seq` via `INSERT … ON CONFLICT … DO UPDATE`).
- `lib/ids.ts` was rewritten to call `nextSeq` and shadow-write Mongo `counters` gated on `WRITE_MONGO_COUNTERS` (default ON for soak; flip OFF after verification).
- The four shop-creation paths (`app/api/admin/shops/route.ts`, `app/api/enterprise/shops/route.ts`, `app/api/platform-admin/shops/route.ts`, `app/api/admin/db-indexes/route.ts`) seed PG from `max(shopId)` via `bumpSeq(floor=maxId)` so monotonicity holds across the cutover. The db-indexes admin route additionally bumps the underlying PG sequence on the legacy `shops_id_seq` so the next direct `INSERT` aligns.
- **Soak**: leave `WRITE_MONGO_COUNTERS=1` for ≥168 h; verify Mongo `counters.shops.seq == pg_counters.seq` for the `shops` counter, then flip to `"0"`.

### 11.3 API keys — PG canonical, Mongo shadow gated (2026-05-04)

- `lib/data/repositories/api-keys.ts` rewritten against Drizzle — reads come from `pg_api_keys`, inserts mint a fresh ObjectId hex string (kept in PG `_id` for back-compat with Mongo readers under shadow), and `external_api_usage_logs` insert path mirrors the same.
- Mongo shadow write gated on `WRITE_MONGO_API_KEYS`. Default ON for soak.
- The Mongo-only consumers (`lib/external-api/api-keys.ts`, partner-keys admin route) keep their call signatures because the repository hides the storage swap.
- **Soak**: leave `WRITE_MONGO_API_KEYS=1` for ≥168 h; spot-check that Mongo `api_keys` and `pg_api_keys` agree row-for-row on inserted records and revocations, then flip to `"0"`.

### 11.4 Events — PG canonical, Mongo shadow gated (2026-05-04)

- `lib/data/repositories/events.ts` rewritten against Drizzle for `recordEvent` and the list-recent reads used by `lib/evidence.ts`.
- Mongo shadow write gated on `WRITE_MONGO_EVENTS`.
- `streamEvents` / `aggregateEvents` (analytics paths) intentionally still query Mongo — moving these requires a SQL aggregation port that is non-trivial and is tracked as an explicit follow-up below.
- **Soak**: leave `WRITE_MONGO_EVENTS=1` until the analytics paths are ported; then flip to `"0"` and remove the Mongo collection.

### 11.5 Backfill scaffolding (`scripts/backfill-mongo-to-supabase.ts`)

The script now has a `MirrorSpec` registry and `--mirror=<name>` flag in addition to the existing per-entity backfill modes. Each spec declares:

- `mongoName` + `pgTableName` + optional `naturalKey: string[]` (for upserts) or implicit `backfill_mongo_id` uniqueness (for append-only mirrors).
- `extract(d) -> {values}` mapping Mongo doc → PG row.
- `buildFilter(shopId)` for per-shop filtering.

The dispatcher routes to `backfillMirror` / `verifyMirror`, both built on the existing checkpoint and retry machinery used by the W3a entities. SQL is generated through Drizzle's `sql` template (`sql.join` + `sql.raw` for identifiers) — `ON CONFLICT (natural_key) DO UPDATE` for natural-key upserts, `ON CONFLICT (backfill_mongo_id) DO NOTHING` for append-only logs.

**Verified-correct mirror specs (ready to run in follow-up soak)**: events, api_keys, external_api_usage_logs, tekmetric_work_orders / repair_orders / vehicles, protractor_work_orders / invoices / vehicles / callback_events, shopware_repair_orders / vehicles / customers / webhook_logs, autoflow_dvi_items / events / af_open, autovitals_vehicles / imports, pre_normalized_*, dvi / dvi_results / canned_jobs / canned_job_applications, plans / plan_cache / recommendations, carfax_reports / history / cache, job_index / job_history / jobs, sms_historical_work_orders.

**Deferred to per-integration follow-up tasks** (require integration-specific knowledge beyond a generic mirror):

- `tekmetric_tokens`, `autoflow_credentials` — encrypted column shapes; cutover should be done by the auth library, not a generic mirror.
- `autovitals_appointments`, `autovitals_inspections` — schema indexes ~12 domain-specific fields each; needs per-integration extract function.

### 11.6 Polarity-flip helpers

- W3a established `lib/integrations/core/normalized-write-mode.ts` (`shouldShadowWriteMongo` family).
- W3b adds `lib/db/wave3-write-mode.ts` mirroring the same pattern: `shouldShadowWriteMongoCounters`, `shouldShadowWriteMongoApiKeys`, `shouldShadowWriteMongoEvents`, plus a generic `shadowWriteMongo(env, fn)` wrapper.

### 11.7 Drift docs — Mongo writes still live after W3b lands

Downstream Wave 4 must not assume Mongo is read-only. The following Mongo collections still receive writes after this PR merges:

| Mongo collection | Still written by | Gate |
| --- | --- | --- |
| `counters` | `lib/ids.ts` shadow path | `WRITE_MONGO_COUNTERS` (default ON) |
| `api_keys`, `api_usage_logs` | `lib/data/repositories/api-keys.ts` shadow path | `WRITE_MONGO_API_KEYS` (default ON) |
| `events` | `lib/data/repositories/events.ts` shadow path; `streamEvents`/`aggregateEvents` analytics path (canonical until ported) | `WRITE_MONGO_EVENTS` (default ON) |
| `tekmetric_*` mirrors | live integration writers (not flipped) | n/a |
| `protractor_*` mirrors | live integration writers (not flipped) | n/a |
| `shopware_*` mirrors | live integration writers (not flipped) | n/a |
| `autoflow_*`, `af_open` | live integration writers (not flipped) | n/a |
| `autovitals_*` | live integration writers (not flipped) | n/a |
| `pre_normalized_*`, `dvi`, `dvi_results`, `canned_jobs`, `canned_job_applications` | live ingestors (not flipped) | n/a |
| `plans`, `plan_cache`, `plan_prefetch_cache`, `recommendations` | live planner writes (not flipped) | n/a |
| `carfax_*`, `job_index`, `job_history`, `jobs`, `sms_historical_work_orders` | live writers (not flipped) | n/a |

### 11.8 Operator-required follow-up enumeration (cannot complete in an isolated task env)

The following items remain open by definition because they require either production cluster access, a multi-day soak window, or a backfill that an isolated task environment cannot perform. They are tracked as W3b-followup tasks per group:

1. **Counters / api_keys / events soak**: leave shadow ON for ≥168 h, verify parity, then flip `WRITE_MONGO_COUNTERS` / `WRITE_MONGO_API_KEYS` / `WRITE_MONGO_EVENTS` to `"0"` and drop the Mongo collections.
2. **Events analytics port**: re-implement `streamEvents` / `aggregateEvents` against PG (`events` table) using SQL window/aggregation; only then can the Mongo `events` collection be dropped.
3. **Tekmetric soak**: run `--mirror=tekmetric_work_orders|tekmetric_repair_orders|tekmetric_vehicles` end-to-end, verify, then port readers + retire Mongo collections. `tekmetric_tokens` is a separate auth-library cutover.
4. **Protractor soak**: run `--mirror=protractor_work_orders|protractor_invoices|protractor_vehicles|protractor_callback_events`, verify, port readers + cache tables (rebuild-on-miss), retire Mongo collections.
5. **Shopware soak**: run `--mirror=shopware_repair_orders|shopware_vehicles|shopware_customers|shopware_webhook_logs`, verify, port readers, retire Mongo collections. `shopware_backfill_progress` cutover is part of the shopware backfill rewrite (separate task).
6. **Autoflow soak**: run `--mirror=autoflow_dvi_items|autoflow_events|af_open`, verify, port readers. `autoflow_credentials` is a separate auth-library cutover.
7. **Autovitals soak**: run `--mirror=autovitals_vehicles|autovitals_imports`, verify, port readers. Add per-integration extract functions for `autovitals_appointments` + `autovitals_inspections`, then run + soak those.
8. **Plan / recommendation cache cutover**: caches allow rebuild-on-miss, so soak can be short. Run `--mirror=plans|plan_cache|recommendations` for convenience, port readers, retire Mongo.
9. **Carfax soak**: run `--mirror=carfax_reports|carfax_history|carfax_cache`, verify, port readers, retire Mongo.
10. **Job index family**: run `--mirror=job_index|job_history|jobs`, verify, port readers, retire Mongo.
11. **SMS history**: run `--mirror=sms_historical_work_orders`, verify, port readers, retire Mongo.
12. **Pre-normalized retirement**: per-reader decision table — for each consumer of the legacy `vehicles` / `customers` / `repair_orders` / `manual_vehicles` Mongo collections, decide whether to (a) re-point at `normalized_*` (W3a output) which is preferred, or (b) re-point at `pre_normalized_*` (W3b mirror) as a port-one-for-one fallback. Then drop the Mongo collections via the Wave 0 procedure.


## §12 Operational primitives PG-readiness (task #557, 2026-05-30)

Task #557's deliverable is **code-readiness, not production operations**. The
data-bearing Mongo tail (plans/AI caches, reference/lookup data, auth tokens,
billing audit) was already scaffolded with PG schema + backfill specs by Waves 1–4
and is **operator-gated** (see the per-group enumerations in §10.5 and §11.8 — those
backfills, soaks, reader ports, and Mongo retirements remain operator-only). The one
genuinely-missing, self-contained, operationally-safe piece was the operational
primitives that have no backfill (they are transient runtime state): the **cron
distributed lock** and the **Tekmetric shared rate-limiter token buckets**. This
section documents the PG backend added for those two, behind default-off flags.

### 12.1 Schema landing

`lib/db/schema/operational.ts` defines two Drizzle tables, exported via
`lib/db/schema/index.ts`. Drizzle migration mirror is
`drizzle/0018_task557_operational_primitives.sql` (`CREATE TABLE IF NOT EXISTS`,
schema-only — **NOT applied to any DB in this task env**; dev Postgres == shared
Supabase, so the operator applies it at cutover).

| Table | Purpose | Mongo equivalent |
| --- | --- | --- |
| `cron_locks` | distributed lock for the in-process node-cron scheduler (one row per job, `expires_at` lease + `instance_id` fence) | the Mongo-backed lock in `lib/cron/scheduler.cjs` |
| `tekmetric_rate_buckets` | per-second token buckets for the cross-process Tekmetric rate limiter (`bucket_key` = `tek:<epoch-second>`, `count`, `expires_at`) | the `tek:<second>` bucket docs the limiter upserts in Mongo |

Both tables hold **transient runtime state only** — there is intentionally **no
backfill**. Cron leases self-heal on TTL takeover; rate buckets are recreated every
second. A cutover is a flag flip with no data migration.

### 12.2 Cron distributed lock — PG backend behind `CRON_LOCK_PG_CANONICAL`

- `lib/cron/scheduler.cjs` keeps the Mongo lock as the default. The original
  acquire/release were renamed `*Mongo`; a PG pair (`tryAcquireLockPg` /
  `releaseLockPg`) was added and the dispatchers select on
  `CRON_LOCK_PG_CANONICAL === "1"` (default off → Mongo, behavior unchanged).
- PG client is a lazy `require("postgres")` with `max: 1` (`getCronPgSql()`).
- **Acquire** is a single `INSERT … ON CONFLICT (job_name) DO UPDATE … WHERE
  cron_locks.expires_at <= now() OR cron_locks.instance_id = <self>` returning the
  row — this preserves the Mongo semantics: a free/expired lease can be taken, and
  the current holder can refresh its own lease, but a live lease held by another
  instance blocks.
- **Release** is fenced: `DELETE … WHERE job_name = $1 AND instance_id = $2`, so a
  stale holder cannot free a successor's lock.
- Both dispatchers **fail closed** on a PG error (treat as "lock not acquired") so a
  DB blip cannot run a job on two instances at once.

### 12.3 Tekmetric shared rate-limiter — PG backend behind `TEKMETRIC_SHARED_LIMITER_PG_CANONICAL`

- `lib/integrations/tekmetric/shared-rate-limiter.ts` was refactored to a small
  `BucketBackend` interface (`inc(key, now) -> count`, `dec(key)`). `mongoBucketBackend`
  preserves the existing `findOneAndUpdate`/`$inc` behavior; `pgBucketBackend` is the
  new path, selected by `TEKMETRIC_SHARED_LIMITER_PG_CANONICAL === "1"` (default off →
  Mongo, behavior unchanged).
- PG **increment** is `INSERT … ON CONFLICT (bucket_key) DO UPDATE SET count = count + 1
  RETURNING count`; **decrement** (slot release when over cap) is `UPDATE … SET
  count = count - 1`. Expiry is enforced by an opportunistic (~1%) `DELETE … WHERE
  expires_at <= now()` sweep, replacing the Mongo TTL index.
- All higher-level semantics are unchanged regardless of backend: effective cap,
  priority lanes (`interactive` reserve vs. `background` ceiling), fail-open
  (`TEKMETRIC_SHARED_LIMITER_FAIL_OPEN`) vs. fail-closed on sustained over-cap, and
  per-process fallback (`acquired: true, fallback: true`) when the store is
  unavailable or errors mid-loop.

### 12.4 Tests

- `tests/cron-lock-pg.smoke.ts` and `tests/tekmetric-shared-rate-limiter-pg.smoke.ts`
  drive the PG paths with **injected fake `sql` clients** (no real DB) and assert the
  contracts above (lease takeover, fenced release, cap/priority/fail-open/closed,
  fallback-on-error). Wired into `test:smoke` next to the existing cron / rate-limiter
  tests via `test:cron-lock-pg` and `test:tekmetric-shared-rate-limiter-pg`.
- The pre-existing Mongo-path smoke tests (`test:cron-scheduler-fetch-timeout`,
  `test:tekmetric-shared-rate-limiter`) still pass with the flags off, confirming
  default behavior is unchanged.

### 12.5 Operator-required follow-ups (cannot complete in an isolated task env)

Same gating rationale as §10.5 / §11.8 — these need production access and a soak
window:

1. Apply `drizzle/0018_task557_operational_primitives.sql` to Supabase.
2. **Cron lock cutover**: with both instances running, flip `CRON_LOCK_PG_CANONICAL=1`.
   Because leases are transient (TTL self-heal), no backfill is needed; verify only
   one instance runs each job for one full schedule cycle, then leave it on. Roll back
   by clearing the flag.
3. **Rate-limiter cutover**: flip `TEKMETRIC_SHARED_LIMITER_PG_CANONICAL=1`; buckets
   regenerate per-second, so no backfill. Verify combined attempted RPS still honors
   the cap during a busy window, then leave it on.
4. Only after both have soaked on PG (alongside every other Mongo store reaching
   PG-canonical per §10.5 / §11.8) can the Mongo driver be removed and the Mongo
   `locks` / `tek:*` bucket collections dropped (Wave 0 procedure). This final
   decommission is the downstream "Final MongoDB decommission" task — **not** part of
   #557.


## 13. Task #999 — Integration operational stores → flag-gated PG repositories

Task #999 extends the §12 precedent (operational primitives, flag-flip cutover) to
the remaining **integration operational stores**: Tekmetric tokens / backfill
progress & mileage progress / health & permfailed alerts / skipped-RO archive /
catchup runs / drain lock / webhook logs·subscriptions·health; Protractor
`backfill_progress` (incl. the inline chunk lease) / service items / template
cache / deferred work / webhook subscriptions; Shop-Ware `shopware_backfill_progress`;
AutoVitals appointments / inspections / imports; and the cross-provider
`api_usage` log + `api_rate_limits` slots.


### 13.2 Schema

Most tables pre-existed in `lib/db/schema/wave2.ts` / `wave3.ts`
(`drizzle/0012`, `drizzle/0014`). Task #999 adds `lib/db/schema/integration-ops.ts`
+ `drizzle/0023_task999_integration_ops.sql` (idempotent, NOT applied here):
`protractor_backfill_progress` (lease columns + `extra` jsonb),
`protractor_webhook_subscriptions`, `integration_drain_locks` (one lease row per
provider, preserving the Mongo `_id:"global"` insert-or-take-over-if-expired /
owner-fenced refresh & release semantics), `api_usage` (Mongo `_id` hex PK →
idempotent backfill; `(provider,timestamp)` + `(shop_id,timestamp)` indexes for
the 1/5/60-minute window reads), `api_rate_limits`.

Quirk: `tekmetric_tokens` in Mongo is a **single global doc** keyed
`{ tokenKey: "current" }`; PG keys by `shop_id`, so the global doc maps to the
`shop_id = 0` sentinel (documented in `lib/data/repositories/tekmetric-ops.ts`).
Also note the "`ln`" collection mentioned in older notes is **not** a runtime
store — the live Shop-Ware progress collection is literally
`shopware_backfill_progress`.


### 13.3 Repositories

`lib/data/repositories/{tekmetric-ops,protractor-backfill-progress,protractor-service-items,protractor-webhook-subscriptions,shopware-ops,autovitals-imports,api-usage}.ts`
(+ extensions to the existing `protractor-template-cache`, `protractor-deferred-work`,
`autovitals-appointments`, `autovitals-inspections` repos), each dispatching to a
`pg/*` twin. Unknown/undeclared Mongo fields round-trip via `extra`/`payload`
jsonb so flag-OFF and flag-ON docs are shape-identical to callers.


### 13.4 Transient vs durable → backfill classification

- **Transient (pure flag flip, NO backfill):** drain locks, `api_rate_limits`
  slots, all `*_backfill_progress` heartbeats/leases, mileage progress,
  Protractor template cache & deferred-work snapshots (rebuilt on demand),
  webhook-health alert dedup rows.
- **Durable (operator backfill before flip):**
  - Tekmetric webhook logs/subscriptions, health & permfailed alerts, skipped-RO
    archive, catchup runs → `scripts/wave2-mongo-to-pg-backfill.ts` (pre-existing).
  - `protractor_callback_events`, `shopware_webhook_logs`, `autovitals_imports`
    → `scripts/backfill-mongo-to-supabase.ts` mirror specs (pre-existing).
  - `api_usage`, `tekmetric_tokens`, `protractor_webhook_subscriptions`,
    `autovitals_appointments`, `autovitals_inspections` →
    **`scripts/backfill-integration-ops.ts`** (new; chunked `_id`-ordered walk,
    idempotent upserts, per-spec checkpoint in `integration_ops_backfill_state`,
    `--only=` / `--batch=` / `--restart`).


### 13.1 Flags (all default OFF → Mongo canonical, behavior unchanged)

| Flag | Shadow-write kill switch | Domain |
| --- | --- | --- |
| `TEKMETRIC_OPS_PG_CANONICAL` | `WRITE_MONGO_TEKMETRIC_OPS` | all Tekmetric operational stores above |
| `PROTRACTOR_OPS_PG_CANONICAL` | `WRITE_MONGO_PROTRACTOR_OPS` | Protractor operational stores |
| `SHOPWARE_OPS_PG_CANONICAL` | `WRITE_MONGO_SHOPWARE_OPS` | `shopware_backfill_progress` |
| `AUTOVITALS_CACHE_PG_CANONICAL` (existing) | `WRITE_MONGO_AUTOVITALS_CACHE` | AutoVitals appointments/inspections/imports (sibling consistency) |
| `API_USAGE_PG_CANONICAL` | `WRITE_MONGO_API_USAGE` | `api_usage` + `api_rate_limits` |

Flag helpers live in `lib/db/integration-ops-write-mode.ts` (plus local helpers in
`lib/data/repositories/api-usage.ts`). PG-canonical = PG read/write + non-fatal
Mongo shadow write via `shadowWriteMongoIntegrationOps`.


### 13.5 Known remainders (left on Mongo deliberately)

- `protractor_callback_events` runtime flow (ObjectId contract threaded across
  the webhook request path, ~40 sites) — needs a dedicated task; the backfill
  mirror spec already exists.
- The giant `app/api/cron/tekmetric-backfill/route.ts` progress logic and
  `workers/processors/drain-tekmetric.ts` (`$unset`/`findOneAndUpdate` shapes) —
  drain-lock sites are migrated, heavy progress logic is not.
- Bespoke Mongo aggregation dashboards (`admin/api-usage`, platform-admin usage
  summaries, webhook-subscription-status latency percentiles, skipped-RO `$group`).
- Cross-provider helper `lib/integrations/backfill-pace.ts`
  (`reopenCompletedShopsForHorizon`) and diagnostic/one-off scripts.
