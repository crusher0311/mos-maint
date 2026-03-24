# MOS Maintenance MVP

## Overview
MOS Maintenance MVP is an AI-enhanced automotive maintenance management system built with Next.js. Its primary purpose is to optimize operations for auto shops by providing tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. The system aims to significantly boost operational efficiency and customer engagement through an intuitive dashboard, various integrations, and AI-powered insights, with a vision to become the leading platform for automotive service management.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, primarily with TypeScript. The architecture employs a dual-database strategy, utilizing Supabase PostgreSQL for core relational data, CRM, and communications, and MongoDB Atlas for caching and legacy features.

**UI/UX Decisions:**
The UI adopts a modern SaaS aesthetic, characterized by a dark sidebar, light content areas, and card-based layouts accented with blue. Key features include a unified integrations page, tabbed vehicle detail views, visual data source badges, and dedicated UIs for "My Oil Sticker" and "Quick Sticker" with customization and rapid printing. A visual designer with drag-and-drop functionality is provided for keytag printing. Vehicle Health Intelligence (VHI) pages display OEM logos and dynamic vehicle titles, and VIN tooltips offer service-relevant specifications.

**Technical Implementations:**
*   **Data Management**: Core CRM and communication data reside in Supabase PostgreSQL, accessed via Drizzle ORM and a repository pattern. OEM maintenance data is also stored here, updated weekly. MongoDB Atlas is used for caching.
*   **Integration Mechanisms**: A modular integration layer supports various shop management systems (e.g., Tekmetric, Protractor, Shop-Ware) using adapter and facade patterns, incorporating webhooks, incremental sync, and OAuth.
*   **Authentication & Authorization**: Role-based access is implemented with bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: Stripe integration handles VIN-based billing, supports modular feature flags, and manages various plan tiers, including automatic CRM provisioning for new shops.
*   **Admin & Monitoring**: The system includes admin audit logging, unified API usage monitoring, a support ticketing system, and a platform observability page for logs and API analytics.
*   **Notification System**: Email notifications are handled via Resend API, complemented by in-app notifications.
*   **AI Support Chatbot**: An OpenAI-powered floating chat widget provides instant answers, knowledge base retrieval, and ticket escalation.
*   **Sticker & Keytag Generation**: QR codes are generated via HoverCode API, and stickers/keytags are rendered using `node-canvas` for efficient, dependency-free printing with Dymo label printer support.
*   **Chrome Extensions**: Two extensions enhance functionality: one for Shop-Ware for context detection and adding repair order items, and "Detect Dog" for Tekmetric, Shop-Ware, and AutoFlow, offering maintenance recommendations, job history, and an AI-powered customer concern assistant.
*   **AI & Recommendations**: The system provides AI-powered maintenance recommendations, job search, smart job autocomplete, and a common failures advisor.
*   **Work Order Creation**: A multi-step wizard facilitates creating Protractor work orders from the dashboard, integrating AI assistance and VIN/license plate recognition.
*   **Vehicle Health Report (VHR)**: A shareable, mobile-friendly customer-facing report page displays a health score, overdue items, a service timeline, and due-soon details. Share links are generated with signed, expiring tokens.
*   **VHI API Endpoints & On-Demand Analysis**: Both internal and external API endpoints provide Vehicle Health Indicator data, including a health score and bucketed maintenance items. On-demand analysis allows real-time VHI generation upon request.
*   **Partner API Keys**: Global API keys for integration partners facilitate shop resolution per-request and enable broader access.
*   **VHI Auto-Build & Rebuild**: VHI data is automatically built when work orders are created and rebuilt when they are closed, ensuring up-to-date maintenance recommendations.
*   **Swagger UI**: Interactive API documentation is available at `/docs` and `/api/docs/ui`.
*   **Common Maintenance Layer**: Industry-standard maintenance items are automatically integrated into plans when not covered by OEM data, respecting shop-specific overrides.
*   **Communications**: Twilio powers voice calling, SMS, voicemail recording, and caller ID lookup, with conversation tracking and data stored in PostgreSQL.
*   **Rescue Rover AI Voice Agent**: An AI-powered phone assistant handles inbound calls using Twilio media streams, Deepgram for STT/TTS, and OpenAI GPT-4o for conversational intelligence, including customer lookup, callback scheduling, and call transfer.
*   **Call Center Management**: Phone number management (assign Twilio numbers to accounts/locations), agent groups with performance targets, time tracking (clock in/out with break management), call activity dashboard with agent leaderboard, and canned message templates. Tables: groups, agent_targets, time_entries, canned_messages. Pages under CRM → Communications in platform-admin sidebar.

## External Dependencies
*   **Database**: MongoDB Atlas, PostgreSQL (Supabase)
*   **AI**: OpenAI API, Deepgram (STT Nova-2, TTS Aura)
*   **Payments**: Stripe
*   **Communications**: Twilio (Voice, SMS, Media Streams)
*   **VIN Decoding & OEM Schedules**: DataOne
*   **Shop Management Systems**: AutoFlow, Protractor, Tekmetric, Shop-Ware
*   **Vehicle History Reports**: CARFAX
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API

## CRM Account Hierarchy
The platform includes a multi-tier CRM account hierarchy ported from AppFueled:
*   **Agencies** → white-label resellers (table: `agencies`)
*   **Parent Organizations** → enterprise groups under agencies (table: `parent_organizations`)
*   **Accounts** → individual shop brands (table: `accounts`)
*   **Locations** → physical addresses tied to accounts (table: `locations`)
*   **User Types** → configurable RBAC roles with JSONB permissions and internal/external bucket classification (table: `user_types`)
*   **Corporate Branding** → branding overrides (logo, colors, favicon) that cascade down the hierarchy (table: `corporate_branding`)
*   **Branding Themes** → reusable theme presets (table: `branding_themes`)
*   **Agency Pricing Packages** → pricing configuration per agency (table: `agency_pricing_packages`)

Schema: `lib/db/schema/crm.ts`, Repository: `lib/db/repositories/crm.ts`
API routes: `/api/platform-admin/crm/{agencies,parent-orgs,accounts,locations,user-types,branding}`
UI pages: `/platform-admin/crm/{agencies,parent-orgs,accounts,locations,user-types}`

The platform-admin sidebar is organized into two top-level sections:
*   **CRM** — Account Hierarchy (Agencies, Parent Orgs, Accounts, Locations, User Types), Contacts, Contact Roles, Communications, Onboarding, Sales Pipeline (Deal Board, Funnel Stages), Marketing (Campaigns, Coupons, Specials, Templates), Pricing (Plans, Products, Promo Codes, Starter Packages)
*   **Ops** — Enterprises/Shops, API Traffic, Partner Keys, Job Analytics, Render Logs, Support Tickets, Knowledge Base, Settings

## CRM Contact Management
The CRM includes a full contact management system for tracking business contacts across the account hierarchy (agencies, parent orgs, accounts, locations). Key components:
*   **Schema**: `lib/db/schema/crm-contacts.ts` — Tables for contacts, contact_role_types, 4 assignment junction tables, entity_notes, entity_tasks
*   **Repository**: `lib/db/repositories/crm-contacts.ts` — CRUD, search, assignment management, polymorphic entity notes/tasks
*   **API Routes**: Under `app/api/platform-admin/crm/contacts/` and `app/api/platform-admin/crm/contact-role-types/`
*   **Pages**: Contact list (`/platform-admin/crm/contacts`), detail view (`/platform-admin/crm/contacts/[id]`), CSV import (`/platform-admin/crm/contacts/import`), role types (`/platform-admin/crm/contact-role-types`)
*   Entity notes and entity tasks are polymorphic — attachable to any entity type (agency, parent org, account, location, contact)

## CRM Sales Pipeline & Marketing Engine
The platform includes a full sales pipeline and marketing management system:

*   **Sales Pipeline**: Kanban-style deal board (`/platform-admin/sales-pipeline`) with drag-and-drop between funnel stages. Configurable funnel stages (`/platform-admin/sales-pipeline/stages`) with probability tracking. Deal detail page with value, probability, timeline, notes, contact info, and activity tracking.
*   **Marketing**: Campaigns management (`/platform-admin/campaigns`) with delivery metric tracking (delivered/opened/clicked/bounced). Coupons (`/platform-admin/coupons`) with usage tracking and expiry. Specials/promotions (`/platform-admin/specials`). Message templates (`/platform-admin/message-templates`) for Email/SMS/Push with HTML/plain text editor.
*   **Pricing Admin**: Pricing plans (`/platform-admin/pricing-plans`) with monthly/annual pricing, setup fees, trials. Products catalog (`/platform-admin/products`). Promo codes (`/platform-admin/promo-codes`) with redemption tracking. Getting started packages (`/platform-admin/getting-started-packages`) with feature lists.
*   **Schema**: `lib/db/schema/sales-marketing.ts` — Tables: deal_funnel_stages, deals, campaigns, coupons, specials, message_templates, pricing_plans, products, product_features, promo_codes, getting_started_packages.
*   **Repository**: `lib/db/repositories/sales-marketing.ts` — Class-based repositories for all entities.
*   **API Routes**: Full CRUD under `/api/platform-admin/sales-pipeline/`, `/api/platform-admin/campaigns/`, `/api/platform-admin/coupons/`, `/api/platform-admin/specials/`, `/api/platform-admin/message-templates/`, `/api/platform-admin/pricing-plans/`, `/api/platform-admin/products/`, `/api/platform-admin/promo-codes/`, `/api/platform-admin/getting-started-packages/`.

## CRM Onboarding & Content System
The platform includes a comprehensive onboarding and content management system:

*   **Onboarding Board**: A Trello-style drag-and-drop board (`/platform-admin/onboarding`) showing location cards moving through configurable onboarding stages (welcome call → go-live).
*   **Schema**: Drizzle ORM tables in `lib/db/schema/onboarding.ts` covering: onboarding_stages, onboarding_stage_assignments, onboarding_steps, onboarding_stage_steps, onboarding_checklists, onboarding_step_checklists, onboarding_cards, onboarding_card_progress, tours, user_tour_progress, onboarding_guides_content, user_onboarding_guide_progress, workflow_sequences, user_workflow_sequence_progress, banners, user_banner_progress, user_favorites, content_assignments.
*   **Repository Layer**: `lib/repositories/onboarding-repository.ts` with OnboardingRepository, ToursRepository, GuidesRepository, WorkflowSequencesRepository, BannersRepository, ContentAssignmentsRepository.
*   **Admin Pages**: Stages management (`/platform-admin/onboarding/stages`), Steps with nested checklists (`/platform-admin/onboarding/steps`), Checklists (`/platform-admin/onboarding/checklists`), Tours with step editor (`/platform-admin/tours`), Guides with step editor (`/platform-admin/guides`), Banners (`/platform-admin/banners`), Content assignments to user types (`/platform-admin/content-assignments`).
*   **API Routes**: Full CRUD under `/api/platform-admin/onboarding/`, `/api/platform-admin/tours/`, `/api/platform-admin/guides/`, `/api/platform-admin/workflow-sequences/`, `/api/platform-admin/banners/`, `/api/platform-admin/content-assignments/`.

## Normalized Data Schema (Supabase)
Six Drizzle ORM tables in Supabase PostgreSQL that mirror the core normalized MongoDB collections, enabling eventual dual-write migration from MongoDB:
*   **Schema**: `lib/db/schema/normalized.ts` — Defines 14 Postgres enums and 6 tables: `normalized_vehicles`, `normalized_customers`, `normalized_work_orders`, `normalized_service_jobs`, `normalized_line_items`, `normalized_payments`
*   **TypeScript Source**: `lib/normalized-schema.ts` — Original MongoDB interfaces that these tables mirror
*   **Migration Script**: `scripts/apply-normalized-migration.ts` — Idempotent script to create enums, tables, foreign keys, and indexes (`npm run db:migrate:normalized`)
*   **Foreign Keys**: `normalized_service_jobs` → `normalized_work_orders`, `normalized_line_items` → `normalized_work_orders` + `normalized_service_jobs`, `normalized_payments` → `normalized_work_orders`
*   **JSONB Columns**: Deeply nested objects stored as JSONB: provenance, softDelete, vinDecodeData, odometerHistory, contacts, addresses, statusHistory, technicians, payments snapshots, laborOperationCodes, componentsCodes, tags, customFields
*   **Indexes**: 44 indexes covering shopId, enterpriseId, VIN, workOrderNumber, foreign keys, timestamps, and key lookup fields
