# MOS Maintenance MVP

## Overview
MOS Maintenance MVP is an AI-enhanced automotive maintenance management system designed to optimize operations for auto shops. It provides tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. The system aims to boost operational efficiency and customer engagement through an intuitive dashboard, various integrations, and AI-powered insights, positioning itself as a leading platform for automotive service management.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built with Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, primarily using TypeScript. It employs a dual-database strategy with Supabase PostgreSQL for core relational data (communications, normalized vehicle/work-order data, support tickets, sniffer/migration tooling), and MongoDB Atlas for caching and legacy features.

**UI/UX Decisions:**
The UI features a modern SaaS aesthetic with a dark sidebar, light content areas, and card-based layouts. Key features include a unified integrations page, tabbed vehicle detail views, visual data source badges, dedicated UIs for "My Oil Sticker" and "Quick Sticker," and a drag-and-drop visual designer for keytag printing.

**Technical Implementations:**
*   **Data Management**: Core communication data resides in Supabase PostgreSQL via Drizzle ORM. MongoDB Atlas is used for caching. Normalized data is dual-written to both databases.
*   **Integration Mechanisms**: A modular integration layer supports various shop management systems using adapter and facade patterns, with Chrome extensions for enhanced functionality.
*   **Authentication & Authorization**: Role-based access is implemented with bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: Stripe integration handles VIN-based billing, supports modular feature flags, and manages plan tiers.
*   **Admin & Monitoring**: Includes admin audit logging, unified API usage monitoring, support ticketing, platform observability, and a Client Health Score dashboard.
*   **Notification System**: Email notifications are handled via Resend API, complemented by in-app notifications.
*   **AI Support Chatbot**: An OpenAI-powered floating chat widget provides instant answers and knowledge base retrieval, with per-shop rate limiting and token ceilings.
*   **Sticker & Keytag Generation**: QR codes are generated, and stickers/keytags are rendered using `node-canvas` for efficient printing.
*   **VHI Coach (DVI Overlay)**: A floating overlay panel in the Detect Dog extension that appears during Digital Vehicle Inspections, matching inspection tasks to canonical service keys and displaying maintenance data.
*   **Pre-fill DVI & Build RO from VHI**: One-click actions in the Detect Dog extension to auto-fill DVI inspection ratings and propose/create jobs in Tekmetric based on VHI maintenance data.
*   **Enhance Notes (AI Findings)**: An AI-powered feature in the Detect Dog extension that rewrites technician inspection findings into professional customer-facing language.
*   **AI & Recommendations**: Provides AI-powered maintenance recommendations, smart job autocomplete, and a common failures advisor.
*   **Estimate Assist & Audit**: A comprehensive system including a Job Knowledge Base, Smart Job Builder API, AI Estimate Language API, and an Estimate Audit Engine.
*   **Work Order Creation**: A multi-step wizard for creating Protractor work orders, integrating AI assistance and VIN/license plate recognition.
*   **Vehicle Health Report (VHR)**: A shareable, mobile-friendly customer-facing report displaying health scores and service timelines.
*   **VHI API Endpoints & On-Demand Analysis**: Provides Vehicle Health Indicator data and real-time VHI generation.
*   **Common Maintenance Layer**: Industry-standard maintenance items are integrated into plans, respecting shop-specific overrides.
*   **Service Key Matching**: A shared module for normalizing free-text service job names to canonical service keys.
*   **Communications**: Twilio powers voice calling, SMS, voicemail recording, and caller ID lookup with conversation tracking.
*   **Call Center Management**: Features include phone number management, time tracking, a call activity dashboard, and canned message templates.
*   **Tekmetric Webhook Integration**: Robust webhook integration for Tekmetric events, including safety nets, HMAC verification, and auto-subscription.
*   **Job Search Triple-Source**: Job search queries legacy MongoDB, normalized MongoDB, and Supabase PostgreSQL in parallel, with results deduplicated and scored.
*   **In-Process Cron Scheduler**: A `node-cron` based scheduler runs inside the main web service, utilizing a Mongo-backed distributed lock for concurrency safety.
*   **Tekmetric Migration Wizard**: A platform-admin tool within the Detect Dog Chrome extension for migrating Tekmetric open jobs, preserving data integrity and providing detailed audit logs.
*   **Backfill Drain Workers**: Standalone Node scripts that walk every incomplete shop to completion in one long-running process, bypassing the cron's per-tick chunk budget and 300s ceiling. Two variants: (1) `npm run drain:tekmetric-backfill` imports `backfillShopChunk` from the route and loops chunks per shop; holds an exclusive Mongo lease (`tekmetric_drain_lock`, 5-min TTL with 60s refresh) so cron GET/POST handlers no-op while it runs, eliminating the cursor-clobber race. (2) `npm run drain:protractor-backfill` calls `runProtractorBackfill(shopId)` per shop (it self-recurses chunks to completion); no global lock needed because Protractor's per-shop atomic lock with 30-min stale-recovery already handles concurrent cron+drain safely. Both configurable via `DRAIN_PARALLELISM`, `DRAIN_HEARTBEAT_MS`, `DRAIN_SHOP_IDS`. Both load `server-only`-tainted modules through a require-hook stub at `scripts/_stubs/server-only-stub.cjs`.
*   **CRM and Rescue Rover Extracted**: The CRM subsystem (Account Hierarchy, Contacts, Sales Pipeline, Marketing, Pricing, Onboarding board / tours / guides / banners / content assignments) and the Rescue Rover AI voice agent have been extracted to a separate Replit project. Their code (routes, repositories, schema, components, feature flag, and the rescue-rover WebSocket worker) and the supporting Postgres tables have been removed from this repo. The Mongo collections that previously backed Rescue Rover (`rescue_rover_calls`, `rescue_rover_transcripts`, `rescue_rover_events`) are also out of scope here and should be dropped as part of the new project's data migration.
*   **Day-Based Trial with Card Capture**: When a platform admin creates a shop, a configurable trial window (default 14 days, max 365) is started and a Stripe customer is provisioned. The shop owner is prompted on first login to add a payment method via Stripe Checkout (`mode: setup`); a dashboard banner and modal track this state. Countdown surfaces in the dashboard layout and the billing settings page. A daily cron (`/api/cron/trial-check`) sends reminder emails on a platform-admin-tunable day schedule (defaults to 7/3/1) using subject/HTML/text templates that admins can edit from the billing settings page (`{{shopName}}`, `{{daysLeft}}`, `{{dayWord}}`, `{{trialEndsAt}}`, `{{addCardUrl}}` placeholders). On trial end the cron either auto-converts the shop to a paid subscription using the saved default payment method or locks/suspends the account and notifies the owner.

## Dead-Code & Legacy Cleanup (Task #301)
*   **`_archive/`** removed — no live importer referenced it. The webpack ignore-glob in `next.config.js` retains the entry as a no-op safety net for future dumps.
*   **AutoFlow canonical**: `lib/integrations/autoflow.ts` (Mongo-based) is the single canonical client used by the live `/api/webhooks/autoflow` route and all routes that resolve AutoFlow config or fetch DVIs. The thin re-export shim `lib/integrations/autoflow-legacy.ts` was deleted. The newer modular adapter under `lib/integrations/autoflow/` is registered with the integration registry but is the target of a separate downstream modularization task — both surfaces remain importable via `lib/integrations/index.ts` until that work lands.
*   **DataOne canonical**: `lib/integrations/dataone-api.ts` (cached + external HTTP fallback) and `lib/integrations/dataone-local.ts` (PostgreSQL direct) are both reachable: every caller that doesn't need the cache reads `dataone-local` directly; the cached path picks local-vs-API at runtime based on `hasUsableIntervals` and is gated globally by `DATAONE_API_FALLBACK_ENABLED` (default ON). Set to `"false"` to disable the external HTTP service without a code deploy.
*   **Protractor sync**: `app/api/cron/protractor-sync/route.ts` is the canonical daily sync (real-time updates flow through `/api/webhooks/protractor/[token]`). The disabled `scripts/protractor-sync-worker.ts` HTTP-loop worker and the route's `DISABLE_PROTRACTOR_SYNC` runtime kill-switch were removed. `scripts/protractor-sync-standalone.ts` (used in container-style deploys without HTTP) is unrelated and unchanged.
*   **`appfueled_invoice` plan removed**: Replaced wholesale by `paymentType === "invoice"`. Stripped from the `BillingPlan` enum, `PLAN_FALLBACK_KEYS` map, plan dropdowns, sort orders, conditional checks, plan-color/label maps, and the `VALID_PLANS` PATCH allowlist. New invoice writes log to `audit_logs` as `type: "invoice_billing_set"`; the platform-admin billing read still surfaces historical `appfueled_invoice_set` rows so prior audit history stays visible. `BillingLike.plan === "appfueled_invoice"` shortcuts in `lib/billing-helpers.ts` were removed.
*   **Tekmetric prewarm**: `lib/tekmetric-jobs-prewarm.ts` now runs only the bulk shop-level path. The legacy per-RO `/jobs?repairOrderId=…` fallback (and its `TEKMETRIC_BULK_JOBS_PREWARM_ENABLED` env kill-switch consumer in this file) was removed; if the bulk fetch fails, the prewarm records the error and the regular indexing path warms the cache opportunistically. The per-shop helper `isBulkJobsPrewarmEnabledForShop` and the env variable itself remain in `lib/tekmetric-bulk-jobs.ts` because the backfill chunk pre-pass in `app/api/cron/tekmetric-backfill/route.ts` still reads them.
*   **`scripts/auto-publish-extension.ts`** is intentionally retained — it has a clear runbook in its header comments and is gated by the `EXT_AUTOPUBLISH_DISABLED` / `EXT_AUTOPUBLISH_TRIGGER` env vars.

## Dev Server Notes
*   **Webpack watcher exclusions** (`next.config.js`): The dev server (`next dev`) explicitly ignores `.local/`, `.next/`, `.git/`, `node_modules/`, `.cache/`, `.upm/`, `.config/`, `.dataone/`, `_archive/`, `attached_assets/`, `.replit_integration_files/`, and `tsconfig.tsbuildinfo`. **Do not remove `.local/`** — that path holds Replit's workflow log files, including this dev server's own stdout. Watching it causes every compile log line to retrigger webpack, producing an infinite "Compiled in …" rebuild loop on idle. Use globs only (no RegExp entries) since Next 14's webpack rejects mixed RegExp+string arrays.

## External Dependencies
*   **Database**: MongoDB Atlas, PostgreSQL (Supabase)
*   **AI**: OpenAI API, Deepgram
*   **Payments**: Stripe
*   **Communications**: Twilio
*   **VIN Decoding & OEM Schedules**: DataOne
*   **Shop Management Systems**: AutoFlow, Protractor, Tekmetric, Shop-Ware
*   **Vehicle History Reports**: CARFAX
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API
*   **Logging**: Better Stack