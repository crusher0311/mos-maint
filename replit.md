# MOS Maintenance MVP

## Overview
MOS Maintenance MVP is an AI-enhanced automotive maintenance management system designed to optimize operations for auto shops. It provides tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. The system aims to boost operational efficiency and customer engagement through an intuitive dashboard, various integrations, and AI-powered insights, positioning itself as a leading platform for automotive service management.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

**Chrome Web Store publishing (mos-tools-extension): NEVER auto-publish.** Commit code, bump the manifest version, write the CHANGELOG entry — but DO NOT run `npx tsx scripts/auto-publish-extension.ts` or `scripts/publish-extension.js`. Wait for Brandon to say "publish it" (or equivalent) before sending anything to Google. The auto-publisher uses `CWS_REFRESH_TOKEN` to push directly to CWS, so a single command equals a real Google upload. Set 2026-05-06 after Brandon was surprised that v1.27.2 had been sent to Google without him saying so.

## System Architecture
The application is built with Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, primarily using TypeScript. It employs a dual-database strategy with Supabase PostgreSQL for core relational data and MongoDB Atlas for caching and legacy features.

**UI/UX Decisions:**
The UI features a modern SaaS aesthetic with a dark sidebar, light content areas, and card-based layouts. Key features include a unified integrations page, tabbed vehicle detail views, visual data source badges, dedicated UIs for "My Oil Sticker" and "Quick Sticker," and a drag-and-drop visual designer for keytag printing.

**Technical Implementations:**
*   **Data Management**: Core communication data resides in Supabase PostgreSQL via Drizzle ORM. MongoDB Atlas is used for caching.
*   **Integration Mechanisms**: A modular integration layer supports various shop management systems using adapter and facade patterns, with Chrome extensions for enhanced functionality.
*   **Authentication & Authorization**: Role-based access is implemented with bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: Stripe integration handles VIN-based billing, supports modular feature flags, and manages plan tiers.
*   **Admin & Monitoring**: Includes admin audit logging, unified API usage monitoring, support ticketing, platform observability, and a Client Health Score dashboard.
*   **Notification System**: Email notifications are handled via Resend API, complemented by in-app notifications.
*   **AI Support Chatbot**: An OpenAI-powered floating chat widget provides instant answers and knowledge base retrieval.
*   **Sticker & Keytag Generation**: QR codes are generated, and stickers/keytags are rendered using `node-canvas` for efficient printing.
*   **VHI Coach (DVI Overlay)**: A floating overlay panel in the Detect Dog extension that appears during Digital Vehicle Inspections, matching inspection tasks to canonical service keys and displaying maintenance data.
*   **Pre-fill DVI & Add Concerns from VHI**: One-click actions in the Detect Dog extension to auto-fill DVI inspection ratings and add technician concerns to the RO based on VHI maintenance data (overdue + due-soon services). The advisor builds the matching jobs themselves from those concerns.
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
*   **Tekmetric Bulk Pre-Pass (vehicles + customers)**: Mirrors the existing `/jobs` bulk pre-pass for the other two per-RO endpoints that dominate first-time backfill wall-clock. `runVehiclesPrePass` / `runCustomersPrePass` in `lib/integrations/tekmetric/full-page-backfill.ts` paginate `/vehicles?shop=X` and `/customers?shop=X` once per shop and upsert into `tekmetric_vehicles_cache` / `tekmetric_customers_cache` keyed by `(shopId, vehicleId|customerId)`. Resumable across cron ticks via `vehiclesPrePassNextPage` / `vehiclesPrePassDone` (and customer equivalents) on `tekmetric_backfill_progress`. The full-page worker triggers them after the jobs pre-pass; the chunker route reads from them with API fallback. Env flags: `TEKMETRIC_FULLPAGE_BULK_PREPASS_VEHICLES=true` and `TEKMETRIC_FULLPAGE_BULK_PREPASS_CUSTOMERS=true` enable per-endpoint independently. The shared `TEKMETRIC_FULLPAGE_BULK_PREPASS_SHOPS` allowlist (when set) overrides both flags and applies to jobs/vehicles/customers pre-passes together so a single shop can be opted into the full bulk pipeline. Per-chunk metrics include `vehiclesPrePassHits`/`Misses` and `customersPrePassHits`/`Misses` so on-call can confirm the pre-pass cache is the path doing the work.
*   **Tekmetric Shared Rate Limiter**: Cross-process per-second rate limiter at `lib/integrations/tekmetric/shared-rate-limiter.ts` ensures the combined attempted RPS across all Node processes/services sharing the same Tekmetric OAuth credentials never exceeds Tekmetric's per-key cap. Uses a Mongo-backed token bucket keyed by unix second (collection: `tekmetric_rate_buckets`, TTL ~10s). Tune the global cap with `TEKMETRIC_SHARED_RPS_CAP` (default 8, hard ceiling 10). Break-glass: `TEKMETRIC_SHARED_LIMITER_DISABLED=true` short-circuits the limiter entirely; `TEKMETRIC_SHARED_LIMITER_FAIL_OPEN=true` flips the over-cap timeout from fail-closed (default — caller backs off and retries) to fail-open (caller pass-through with a "CAP BREACH" warning log). Inspect live state with `db.tekmetric_rate_buckets.find().sort({_id: -1}).limit(10)`. On Mongo failure the limiter falls back to per-process behavior with a warning log.
*   **Tekmetric Full-Page Per-Shop In-Flight Lock**: `lib/integrations/tekmetric/inflight-lock.ts` adds per-shop concurrency control to the full-page backfill route. Both the GET cron and POST `{shopId}` handlers acquire a Mongo-backed lock on the existing `tekmetric_backfill_progress` doc (fields `inFlightUntil`, `inFlightStartedAt`, `inFlightOwner`). Default TTL is 6 minutes — a crashed process self-heals on the next cron tick after expiry. POST returns HTTP 409 with `heldBy`, `heldUntil`, and `startedAt` if a run for that shop is already in flight; the GET cron logs and skips the shop instead of starting a duplicate. Lock state is observable on the `catchup-status` endpoint (`inFlightUntil` / `inFlightStartedAt` / `inFlightOwner` on each shop row). Release is owner-scoped so a runaway promise's `finally` cannot clear a TTL-recovered lock.
*   **Job Search Triple-Source**: Job search queries legacy MongoDB, normalized MongoDB, and Supabase PostgreSQL in parallel, with results deduplicated and scored.
*   **In-Process Cron Scheduler**: A `node-cron` based scheduler runs inside the main web service, utilizing a Mongo-backed distributed lock for concurrency safety.
*   **Tekmetric Migration Wizard**: A platform-admin tool within the Detect Dog Chrome extension for migrating Tekmetric open jobs.
*   **Backfill Drain Workers**: Standalone Node scripts for processing incomplete shops in long-running processes, managing concurrency with Mongo leases and atomic locks.
*   **Day-Based Trial with Card Capture**: Implements a configurable trial window with Stripe customer provisioning, payment method capture, and automated trial management via daily cron jobs.

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