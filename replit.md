# MOS Maintenance MVP

## Overview
MOS Maintenance MVP is an AI-enhanced automotive maintenance management system designed to optimize operations for auto shops. It provides tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. The system aims to boost operational efficiency and customer engagement through an intuitive dashboard, various integrations, and AI-powered insights, positioning itself as a leading platform for automotive service management.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built with Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, primarily using TypeScript. It employs a dual-database strategy with Supabase PostgreSQL for core relational data (CRM, communications), and MongoDB Atlas for caching and legacy features.

**UI/UX Decisions:**
The UI features a modern SaaS aesthetic with a dark sidebar, light content areas, and card-based layouts. Key features include a unified integrations page, tabbed vehicle detail views, visual data source badges, dedicated UIs for "My Oil Sticker" and "Quick Sticker," and a drag-and-drop visual designer for keytag printing. Vehicle Health Intelligence (VHI) pages display OEM logos and dynamic vehicle titles.

**Technical Implementations:**
*   **Data Management**: Core CRM and communication data reside in Supabase PostgreSQL via Drizzle ORM. MongoDB Atlas is used for caching. Normalized data is dual-written to both databases.
*   **Integration Mechanisms**: A modular integration layer supports various shop management systems (e.g., Tekmetric, Protractor, Shop-Ware) using adapter and facade patterns. Chrome extensions enhance functionality for these systems, including an API sniffer for platform admins.
*   **Authentication & Authorization**: Role-based access is implemented with bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: Stripe integration handles VIN-based billing, supports modular feature flags, and manages plan tiers.
*   **Admin & Monitoring**: Includes admin audit logging, unified API usage monitoring, a support ticketing system, a platform observability page, and a Client Health Score dashboard.
*   **Notification System**: Email notifications are handled via Resend API, complemented by in-app notifications.
*   **AI Support Chatbot**: An OpenAI-powered floating chat widget provides instant answers and knowledge base retrieval.
*   **AI Budget & Rate Limiting**: All OpenAI-backed routes are gated by per-shop sliding 5-minute request window and per-plan daily token ceilings. Token usage is persisted for tracking.
*   **Sticker & Keytag Generation**: QR codes are generated, and stickers/keytags are rendered using `node-canvas` for efficient printing.
*   **VHI Coach (DVI Overlay)**: A floating overlay panel in the Detect Dog extension that appears during Digital Vehicle Inspections, matching inspection tasks to canonical service keys and displaying maintenance data (overdue, due soon, OK).
*   **Pre-fill DVI**: A one-click button in the Detect Dog extension to auto-fill Tekmetric DVI inspection ratings (Red, Yellow, Green) based on VHI maintenance data.
*   **Enhance Notes (AI Findings)**: An AI-powered feature in the Detect Dog extension that rewrites technician inspection findings into professional customer-facing language, with a shop-specific learning system for advisor edits.
*   **AI & Recommendations**: Provides AI-powered maintenance recommendations, smart job autocomplete, and a common failures advisor.
*   **Estimate Assist & Audit**: A comprehensive system including a Job Knowledge Base, Smart Job Builder API, AI Estimate Language API, and an Estimate Audit Engine.
*   **Work Order Creation**: A multi-step wizard for creating Protractor work orders, integrating AI assistance and VIN/license plate recognition.
*   **Vehicle Health Report (VHR)**: A shareable, mobile-friendly customer-facing report displaying health scores and service timelines.
*   **VHI API Endpoints & On-Demand Analysis**: Provides Vehicle Health Indicator data and real-time VHI generation.
*   **Common Maintenance Layer**: Industry-standard maintenance items are integrated into plans, respecting shop-specific overrides.
*   **Service Key Matching**: A shared module for normalizing free-text service job names to canonical service keys.
*   **Communications**: Twilio powers voice calling, SMS, voicemail recording, and caller ID lookup with conversation tracking.
*   **Rescue Rover AI Voice Agent**: An AI-powered SaaS client support phone assistant using Twilio, Deepgram for STT/TTS, and OpenAI GPT-4o.
*   **Call Center Management**: Features include phone number management, agent groups, time tracking, a call activity dashboard, and canned message templates.
*   **CRM Account Hierarchy**: A multi-tier CRM account hierarchy supporting Agencies, Parent Organizations, Accounts, and Locations with configurable RBAC and branding overrides.
*   **CRM Contact Management**: A full contact management system for business contacts across the account hierarchy.
*   **CRM Sales Pipeline & Marketing Engine**: Includes a Kanban-style deal board, configurable funnel stages, campaigns, coupons, specials, message templates, and pricing administration.
*   **CRM Onboarding & Content System**: Provides a Trello-style onboarding board, tours, guides, banners, and content assignment.
*   **Tekmetric Webhook Integration**: Robust webhook integration for Tekmetric events, including safety nets for health monitoring, HMAC signature verification, and auto-subscription capabilities, ensuring reliable data ingestion into normalized tables.
*   **Job Search Triple-Source**: Job search queries legacy MongoDB, normalized MongoDB, and Supabase PostgreSQL in parallel, with results deduplicated and scored.
*   **Production Log Caching**: Production logs from Better Stack are synced to a Supabase table for fast, filterable access.
*   **In-Process Cron Scheduler**: A `node-cron` based scheduler runs inside the main web service, utilizing a Mongo-backed distributed lock for concurrency safety across autoscaled instances.
*   **Tekmetric Skipped-RO Retry**: A daily cron (`/api/cron/tekmetric-ro-retry`, 05:30 UTC) walks each shop's `recentSkippedRos` list on `tekmetric_backfill_progress`, fetches each RO + its jobs/vehicle/customer/inspections via single-RO endpoints, and re-indexes them into `job_index` and the normalized collections. Successful retries are removed from the skip list, increment a per-shop `recoveredRoCount`, and append to a capped `recoveredRos` history. Failed retries bump per-RO `retryAttempts` / `lastRetryError`; after 3 attempts the RO is marked `permanentlyFailed` and stops being retried. Per-run budget caps (10 shops × 10 ROs, 50 ROs total) keep the cron well under the Tekmetric quota. The admin sync-health view exposes recovered / still-failing / permanently-failed counts per shop and an aggregate "Recovered ROs" stat card.
*   **Tekmetric Backfill Stuck-Shop Alerting**: A daily cron (`/api/cron/tekmetric-backfill-health`, 06:30 UTC) reuses the `/api/admin/sync-health` diagnostics to email all platform admins (via Resend) when any incomplete Tekmetric shop has `lastRunAt` >48h, a non-null `lastError` (with a `persistent_error` sub-bucket for errors >24h that survived the 6h auto-clear), or a cursor frozen >3 days. Alerts are state-deduped per-shop in `tekmetric_backfill_health_alerts` so the same stuck shop only re-pages when its reasons change, and dedup rows auto-clear when the shop recovers.
*   **CRM Subsystem Feature Flag (`CRM_ENABLED`)**: The CRM, Onboarding, Sales Pipeline, Marketing, and Pricing platform-admin surfaces are soft-hidden behind the `CRM_ENABLED` environment variable (default: `false`). When disabled: gated UI routes (`/platform-admin/{crm,onboarding,sales-pipeline,campaigns,coupons,specials,message-templates,agent-groups,tours,guides,banners,content-assignments,pricing-plans,products,promo-codes,getting-started-packages}`) return 404 via per-directory `layout.tsx` files calling `notFound()`; the matching API routes under `/api/platform-admin/*` plus `/api/admin/provision-crm-signup` return `{"error":"Not Found"}` with HTTP 404; and the platform-admin sidebar hides the CRM/OPS tab switcher (forcing OPS-only view), the CRM tab body, and the Communications → Agent Groups link. Helper: `lib/feature-flags/crm.ts` (`isCrmEnabled()`) and `lib/feature-flags/gate.ts` (`crmDisabledResponse()`). No tables are dropped and no code is removed; flipping the env var to `true` fully restores the subsystem. Auth, billing, sticker, VHI, DVI, communications (other than Agent Groups), and shop-management surfaces are unaffected.

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