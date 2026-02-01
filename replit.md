# MOS Maintenance MVP

## Overview
This project is an AI-enhanced automotive maintenance management system built with Next.js. Its primary purpose is to streamline operations for auto shops by providing tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. It features an intuitive dashboard and aims to improve operational efficiency and customer engagement through various integrations and AI-powered insights.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, with TypeScript/JavaScript. Data management is transitioning from MongoDB Atlas to PostgreSQL for core relational data, with MongoDB Atlas currently used for caching.

**UI/UX Decisions:**
The user interface features a modern SaaS design with a dark sidebar, light content areas, and card-based layouts, accented with blue. Key UI elements include a unified integrations page, tabbed vehicle detail pages, visual data source badges, and dedicated UIs for "My Oil Sticker" and "Quick Sticker" with customization and rapid printing. Keytag printing includes a visual designer with drag-and-drop editing and live preview. The Health Intelligence plan page displays OE manufacturer logos (locally hosted in `/public/logos/makes/`), dynamic Year/Make/Model titles, and "Vehicle Health Intelligence" branding with icon on the right side. VIN tooltips show service-relevant specs (front/rear tires, front/rear brakes, wheelbase).

**Technical Implementations:**
*   **Data Management**: Data is transitioning from MongoDB Atlas to PostgreSQL. Plan caching stores assembled plan buckets for instant loads with mileage tolerance-based invalidation.
*   **Integration Mechanisms**: A modular integration layer supports shop management systems (e.g., Tekmetric, Protractor) through `IIntegrationAdapter` and `IntegrationFacade` patterns, incorporating webhooks, incremental sync, OAuth, and rate limiting. An `ISMSAdapter` interface normalizes SMS data.
*   **Authentication & Authorization**: Role-based access using bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: VIN-based billing with trial limits, Stripe integration, modular feature flags, and robust grace period handling. Grace periods (7 days) automatically trigger on payment failure with email reminders at days 3-4 and 1-2 remaining. Accounts transition to suspended status when grace expires, with automatic feature disable. Admins can extend grace periods via `/api/admin/billing/extend-grace`. Daily cron job checks expired grace periods (`scripts/daily-grace-check.ts`).
*   **Admin & Monitoring**: Includes comprehensive admin audit logging, unified API usage monitoring, and a support ticketing system.
*   **Notification System**: Supports email notifications via Resend API and in-app notifications.
*   **AI Support Chatbot**: A floating chat widget provides OpenAI-powered responses, knowledge base retrieval, and ticket escalation.
*   **Sticker & Keytag Generation**: QR codes are generated using HoverCode API, sticker images via `node-html-to-image`, and Dymo label printing is supported with a visual designer.
*   **AI & Recommendations**: Offers AI-powered maintenance recommendations, AI-scored job search, smart job autocomplete, and a common failures advisor.
*   **Auto Booking**: A feature-gated system for automated oil change appointment scheduling.
*   **Chrome Extension**: A side panel extension enhances Tekmetric integration with maintenance recommendations, job history, and sticker printing.

**Feature Specifications:**
*   **Core Management**: Vehicle analysis, customer dashboards, and multi-shop management.
*   **Maintenance & Service**: Intelligent queue-based prefetching for maintenance planning, component tracking, and logging declined services.
*   **Enterprise Capabilities**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution, enterprise-wide job search, and settings replication.
*   **Modular Features**: A la carte feature flags control functionalities like maintenance, job lookup, oil stickers, keytags, auto booking, and part cross-reference.
*   **User Preferences**: Shops can select their preferred distance units (miles/kilometers).

## PostgreSQL Migration Status (In Progress)
**Goal**: Full cutover to PostgreSQL - eliminate MongoDB entirely

**Completed Phases:**
- Phase 1: PostgreSQL schema created (109 tables)
- Phase 2: Dual-write ingestion (Tekmetric/Protractor sync writes to both DBs)
- Phase 3: Historical data migrated:
  - 309,781 customers
  - 167,803 vehicles
  - 497,216 work orders
  - 24 shops
  - 7,029 Tekmetric work orders
  - 2,924 Protractor work orders
  - 2,660 Protractor vehicles
  - 3,276 events

**Remaining Phases:**
- Phase 4: Update lib files to read from PostgreSQL
- Phase 5: Update API routes to use PostgreSQL
- Phase 6: Remove MongoDB dependencies

**Key Migration Files:**
- `lib/postgres-ingestion.ts` - PostgreSQL data ingestion service
- `scripts/etl-phase3-remaining.ts` - ETL script for historical data
- `lib/db/postgres.ts` - PostgreSQL connection

## External Dependencies
*   **Database**: PostgreSQL (primary), MongoDB Atlas (legacy - being phased out)
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne (local PostgreSQL, SFTP sync weekly)
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API

## Important Project Files
*   **FEATURE_BACKLOG.md**: Tracks all planned features and future work items. Always check this file for pending enhancements.
*   **MOS-REBUILD-PLAN.md**: Long-term architecture roadmap for ground-up rebuild.