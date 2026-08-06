# MOS Maintenance MVP

## Overview
MOS Maintenance MVP is an AI-enhanced automotive maintenance management system for auto shops. It manages vehicle maintenance recommendations, customer data, and multi-shop users, and drives operational efficiency and customer engagement through a dashboard, third-party integrations, and AI-powered insights.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

**Log filtering default:** When checking production logs / Better Stack for this app, filter to the `mos-maintenance-mvp-main` host (appname `web-*`) by default. Multiple unrelated apps (e.g. `heart-helper`) share the same Better Stack feed; their errors (like the RingCentral call-sync failures) are NOT this app's and should not be reported as MOS issues unless I'm explicitly asked to look across all apps. (Set 2026-06-02.)

**Production deploys (Render, mos-tools): Brandon triggers deploys.** Commit and push code to main, then tell Brandon what's ready — do NOT trigger Render deploys or rollbacks via the Render API on my own. Exception: none by default; if prod is actively down/degraded, ask Brandon first and act only with his go-ahead. Note: after any Render rollback, push-to-main auto-deploy may not fire — tell Brandon to check that Render actually starts a build. (Set 2026-08-06 after I rolled back and re-deployed unilaterally during the Shopmonkey Mongo-saturation incident.)

**Chrome Web Store publishing (mos-tools-extension): NEVER auto-publish.** Commit code, bump the manifest version, and write the CHANGELOG entry — but DO NOT run `scripts/auto-publish-extension.ts`, `scripts/publish-extension.js`, or `npm run ext:auto-publish`. Wait for Brandon to explicitly say "publish it" before anything goes to Google. The auto-publisher uses `CWS_REFRESH_TOKEN` to push straight to CWS, so a single command equals a real Google upload. The post-merge hook (`scripts/post-merge.sh`) does NOT publish on a manifest-version change — it only logs that a publish is pending. There is an intentionally undocumented escape hatch (`POST_MERGE_ALLOW_EXTENSION_PUBLISH=1`); do not set it. (Set 2026-05-06, tightened 2026-05-17 after accidental auto-ships.)

## System Architecture
Built with Next.js 14.2.5, React 18, Next.js API Routes, Tailwind CSS, and TypeScript. Dual-database strategy: Supabase PostgreSQL (via Drizzle ORM) for core relational data, MongoDB Atlas for caching and legacy features. An in-process `node-cron` scheduler runs inside the web service, using a Mongo-backed distributed lock for concurrency safety.

**Build/Deploy guardrail:** `openapi-types` must stay a direct `dependency` in `package.json` (do not move it back to a transitive peer dep) — otherwise the Render build fails the strict lockfile guard (`scripts/check-lockfile-sync.cjs`, run at the front of `prebuild`/`test:smoke`). Do not delete that guard. After any `package.json` dependency change, run `npm install --package-lock-only` and commit `package-lock.json`. Node is pinned to `20.20.0`.

**UI/UX:** Modern SaaS aesthetic — dark sidebar, light content areas, card-based layouts. Includes a unified integrations page, tabbed vehicle detail views, data-source badges, "My Oil Sticker"/"Quick Sticker" UIs, and a drag-and-drop keytag print designer.

**Feature areas (details live in the code and `docs/runbooks/`):**
*   **Integrations**: Modular adapter/facade layer for shop management systems, plus Chrome extensions (Detect Dog).
*   **Auth**: Role-based access, bcrypt hashing, token-based auth. Extension `/api/extension/*` auth errors carry a stable `code` so the extension distinguishes terminal credential failures from transient hiccups and avoids logging users out mid-shift.
*   **Billing**: Stripe VIN-based billing, modular feature flags, plan tiers, and a day-based trial with card capture.
*   **Admin & Monitoring**: Audit logging, API usage monitoring, support ticketing, observability, Client Health Score dashboard, and per-shop error-rate alerting via Better Stack.
*   **Notifications**: Resend email plus in-app notifications.
*   **AI**: OpenAI support chatbot, maintenance recommendations, smart job autocomplete, common-failures advisor, and AI-rewritten inspection findings ("Enhance Notes").
*   **Stickers & Keytags**: QR generation and `node-canvas` rendering for stickers/keytags.
*   **ZINK Cloud Print**: Cloud-side print queue (the cloud never opens a printer socket — a local agent polls/acks jobs), web-app + extension triggers, agent heartbeat, and a platform-admin dashboard.
*   **VHI / DVI**: VHI Coach overlay in the extension, pre-fill DVI and add-concerns actions, VHI API endpoints with on-demand analysis, and a shareable Vehicle Health Report (VHR). Mileage anchoring prefers the most-recent open-RO odometer so partner apps match the extension overlay.
*   **Estimates**: Job Knowledge Base, Smart Job Builder, AI Estimate Language, and an Estimate Audit Engine.
*   **Work Orders**: Multi-step Protractor work-order wizard with AI assistance and VIN/plate recognition.
*   **Maintenance data**: Common Maintenance Layer (industry-standard items with shop overrides) and Service Key Matching (normalize free-text job names to canonical keys).
*   **Communications**: Twilio voice, SMS, voicemail, and caller ID; call-center management (phone numbers, time tracking, activity dashboard, canned templates).
*   **Job Search**: Parallel triple-source search (legacy Mongo, normalized Mongo, Supabase PG) with dedup and scoring.
*   **Tekmetric/Protractor backfill**: Webhook integration (HMAC, auto-subscription), bulk pre-passes (jobs/vehicles/customers), a shared cross-process rate limiter, per-shop in-flight locks, resumable cron sweeps, standalone drain workers, and an optional BullMQ+Redis worker queue (dormant by default behind feature flags).
*   **Migration**: Platform-admin Tekmetric migration wizard (in the extension), and an in-progress Mongo→Postgres canonical-data migration.

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
