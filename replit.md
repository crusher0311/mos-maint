# MOS Maintenance MVP

## Overview
This project is an AI-enhanced automotive maintenance management system built with Next.js. Its primary purpose is to streamline operations for auto shops by providing tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. It features an intuitive dashboard and aims to improve operational efficiency and customer engagement through various integrations and AI-powered insights.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, with TypeScript/JavaScript. MongoDB Atlas is currently used for caching and state tracking, with a planned migration to PostgreSQL for core business data.

**UI/UX Decisions:**
The user interface features a modern SaaS design with a dark sidebar, light content areas, and card-based layouts, accented with blue. Key UI elements include a unified integrations page, tabbed vehicle detail pages, visual data source badges, and dedicated UIs for "My Oil Sticker" and "Quick Sticker" with customization and rapid printing. Keytag printing includes a visual designer with drag-and-drop editing and live preview.

**Technical Implementations:**
*   **Data Management**: Plan caching stores assembled plan buckets for instant loads with mileage tolerance-based invalidation. The system is transitioning from MongoDB Atlas to PostgreSQL for core relational data.
*   **Integration Mechanisms**: A modular integration layer supports shop management systems (e.g., Tekmetric, Protractor) through `IIntegrationAdapter` and `IntegrationFacade` patterns, incorporating webhooks, incremental sync, OAuth, and rate limiting. An `ISMSAdapter` interface normalizes SMS data.
*   **Authentication & Authorization**: Role-based access is implemented using bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: Features VIN-based billing with trial limits, Stripe integration, and modular feature flags.
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

## External Dependencies
*   **Database**: MongoDB Atlas (planned migration to PostgreSQL)
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API

---

## MongoDB → PostgreSQL Migration Plan

### Strategy: Raw Archive + Clean Normalized Tables
- `raw_*` tables: JSONB permanent archive of all MongoDB data
- Normalized tables: Clean relational structure with proper foreign keys
- Transform scripts: Platform-specific logic to populate normalized tables

### Migration Timeline (~9 weeks)

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1. Copy Raw Data | 2 weeks | All MongoDB data in `raw_*` PostgreSQL tables |
| 2. Validate | 1 week | Row counts match, JSONB queryable |
| 3. Build Normalized Schema | 1 week | Create clean tables with relationships |
| 4. Transform Scripts | 2 weeks | Populate normalized tables from raw |
| 5. Cutover Reads | 1 week | App reads from PostgreSQL |
| 6. Cutover Writes | 1 week | New data goes to PostgreSQL |
| 7. MongoDB → Cache Only | 1 week | Remove MongoDB from critical path |

### Rollback Plan
- MongoDB stays fully synced for 30 days
- Feature flag to switch back to MongoDB reads
- `raw_*` tables preserved permanently as audit trail

---

## Architectural Fixes (During Migration)

These issues get fixed as part of the migration, not as separate work.

| Issue | Fix Phase | Solution |
|-------|-----------|----------|
| Customer duplicates | Phase 3 | PostgreSQL unique constraints + `ON CONFLICT` upserts |
| Missing indexes | Phase 3 | Created with normalized tables |
| Backfill race conditions | Phase 4 | PostgreSQL advisory locks |
| N+1 queries | Phase 4 | Batch reads in transform scripts |
| Silent API tracking loss | Phase 5 | Direct PostgreSQL writes (no buffer) |
| Rate limit handling | Phase 5 | Explicit error types in app layer |
| MongoDB connection issues | Phase 7 | PostgreSQL connection pooling |

---

## Backfill Improvement Plan

### Current Problems
- **Backward processing**: New shops wait days before recent data is indexed
- **No webhook sync**: Real-time updates from SMS not captured immediately
- **First-visit cold start**: User sees 10-20s loading spinner
- **500-mile threshold**: Mileage updates trigger full plan rebuild
- **Single-threaded**: One shop at a time, no parallelism

### Improvements

#### 1. Hot Start for New Shops
Process the **last 30 days first**, then backfill history.

```
NEW SHOP ONBOARDING:
Day 0: Sync last 30 days (immediate dashboard utility)
Day 1-3: Backfill 30-90 days
Day 3+: Continue historical backfill in background
```

#### 2. Webhook-Driven Real-Time Sync
When SMS sends webhook, immediately update:
- Customer record
- Vehicle mileage
- Active RO status
- Queue prefetch for that VIN

```
Webhook → Update normalized tables → Queue prefetch → Dashboard shows instantly
```

#### 3. Smarter Prefetch Queue
Prioritize by likelihood of being viewed:
1. **In-progress ROs** (highest priority)
2. **Recently updated vehicles** (webhook-triggered)
3. **Vehicles viewed in last 24 hours**
4. **Scheduled appointments for today/tomorrow**

#### 4. Incremental Plan Updates
Instead of rebuilding the entire plan when mileage changes:
- Update only `milesToGo` and `daysToGo` fields (fast: ~50ms)
- Only fetch new OEM data if crossing a service interval threshold
- Schedule full refresh async if needed

#### 5. Parallel Shop Processing
- Run up to 3 shops in parallel (respecting global rate limits)
- Use PostgreSQL advisory locks for coordination
- Separate worker pools per platform

### Implementation by Phase

| Phase | Improvement | How |
|-------|-------------|-----|
| Phase 3 | Hot Start | Add `hotStartCompleted` flag to shops table |
| Phase 4 | Parallel Processing | PostgreSQL advisory locks + worker pools |
| Phase 5 | Webhook Real-Time Sync | Update normalized tables directly on webhook |
| Phase 5 | Incremental Plan Updates | Separate `plan_summary` (fast) from `plan_details` (slow) |
| Phase 6 | Smarter Prefetch | Query PostgreSQL for active ROs + appointments |

### Expected Results

| Metric | Before | After |
|--------|--------|-------|
| New shop first data | Days | Minutes |
| First-visit load | 10-20s | <2s (cached) |
| Mileage update impact | Full rebuild | Incremental (~50ms) |
| Webhook → Dashboard | N/A | <5 seconds |
| Backfill completion | Days | Hours (parallel) |