# MOS Maintenance MVP

## Overview
This project is an AI-enhanced automotive maintenance management system built with Next.js. Its primary purpose is to streamline operations for auto shops by providing tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. It features an intuitive dashboard and aims to improve operational efficiency and customer engagement through various integrations and AI-powered insights, ultimately enhancing operational efficiency and customer engagement.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, with TypeScript/JavaScript. Data management is transitioning from MongoDB Atlas to PostgreSQL for core relational data, with MongoDB Atlas currently used for caching.

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
*   **VIN Decoding & OEM Schedules**: DataOne (local PostgreSQL, SFTP sync weekly)
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API

---

## Development & Deployment Workflow

### Environment Strategy: "Train How You Fight"
Three isolated environments, but QA mirrors production data for realistic testing.

### Environments

| Environment | Platform | Database | Stripe Mode | Purpose |
|-------------|----------|----------|-------------|---------|
| **Dev** | Replit | Replit PostgreSQL | Test | Active development, experimentation |
| **QA** | Render | QA PostgreSQL (prod mirror) | Test | Pre-production testing with real data patterns |
| **Prod** | Render | Production PostgreSQL | Live | Real customers (24 shops) |

### Render Service IDs
- **QA:** `srv-d5hb86i4d50c738vm4o0`
- **Prod:** `srv-d55jaqkhg0os73a5dd8g`

### Database Mirroring (Prod → QA)
Before testing migrations or major features, sync QA database from production:

```bash
# 1. Dump production database
pg_dump $PROD_DATABASE_URL --no-owner --no-acl > prod_backup.sql

# 2. Restore to QA database (destructive - replaces QA data)
psql $QA_DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql $QA_DATABASE_URL < prod_backup.sql

# 3. Verify row counts match
psql $PROD_DATABASE_URL -c "SELECT COUNT(*) FROM shops;"
psql $QA_DATABASE_URL -c "SELECT COUNT(*) FROM shops;"
```

**When to sync:**
- Before testing database migrations
- Before testing billing changes
- Weekly (recommended) to keep QA data fresh
- After major production data changes

### Deployment Flow

```
┌─────────────────────────────────────────────────────────┐
│  1. DEVELOP (Replit)                                    │
│     - Write code, test locally                          │
│     - Use Replit's PostgreSQL for dev data              │
│     - Stripe test mode for billing work                 │
└────────────────────────┬────────────────────────────────┘
                         │ Deploy to QA
                         ▼
┌─────────────────────────────────────────────────────────┐
│  2. TEST (Render QA)                                    │
│     - Sync prod data to QA database first               │
│     - Test with real data patterns                      │
│     - Verify migrations don't break anything            │
│     - Test billing flows (Stripe test mode)             │
└────────────────────────┬────────────────────────────────┘
                         │ Deploy to Prod (after QA passes)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  3. PRODUCTION (Render Prod)                            │
│     - Real customers, real data                         │
│     - Stripe live mode                                  │
│     - Monitor for issues                                │
└─────────────────────────────────────────────────────────┘
```

### Environment Variables by Environment

**Dev (Replit):**
- `DATABASE_URL` - Replit's built-in PostgreSQL
- `STRIPE_SECRET_KEY` - Test mode key (`sk_test_...`)
- `DEV_AUTO_LOGIN=true` - Skip auth for faster dev

**QA (Render):**
- `DATABASE_URL` - QA PostgreSQL (mirrored from prod)
- `STRIPE_SECRET_KEY` - Test mode key (`sk_test_...`)
- `NODE_ENV=production`

**Prod (Render):**
- `DATABASE_URL` - Production PostgreSQL
- `STRIPE_SECRET_KEY` - Live mode key (`sk_live_...`)
- `NODE_ENV=production`

### Pre-Deployment Checklist

Before deploying to QA:
- [ ] Code tested locally in Replit
- [ ] No console errors
- [ ] Database migrations tested (if any)

Before deploying to Prod:
- [ ] QA testing complete
- [ ] Database sync verified (if migration involved)
- [ ] Stripe billing flows verified (if billing changes)
- [ ] Chrome extension tested (if UI changes)
- [ ] Rollback plan ready

---

## Database Migration Plan

### Strategy: Raw Archive + Clean Normalized Tables
- Archive all raw SMS data (MongoDB → PostgreSQL jsonb)
- Build clean normalized tables (vehicles, customers, repair_orders, etc.)
- 9-week timeline across 7 phases

### Ultimate Performance Targets

| Metric | Current | Target |
|--------|---------|--------|
| Integration → usable dashboard | Days | <2 minutes |
| Webhook → dashboard update | N/A | <5 seconds |
| First vehicle view (cached) | 10-20s | <500ms |
| Mileage update | 10-20s rebuild | 50ms incremental |
| Full backfill completion | Days (serial) | Hours (parallel) |
| Cache hit rate | ~60% | 95%+ |

### Key Optimizations (Built During Migration)
1. **Instant Onboarding** - Fetch last 7 days immediately, dashboard usable in <2 minutes
2. **Webhook Real-Time Sync** - Push-based updates, <5 second latency
3. **Proactive Prefetch** - Predict and cache vehicles before user views them
4. **Incremental Plan Updates** - Fast summary updates (~50ms) vs slow full rebuilds
5. **Parallel Backfill** - PostgreSQL-coordinated workers, hours not days

---

## Post-Migration Priorities

After database migration is complete, focus on these areas before adding new integrations:

### 1. Chrome Extension Fixes
The Tekmetric Chrome extension needs updates to work properly with web-based integrations:
- Side panel integration with maintenance recommendations
- Job history display within Tekmetric interface
- Sticker printing from Chrome extension
- Consistent behavior across all web-based SMS platforms

### 2. Stripe Billing Verification
Ensure billing system is flawless before scaling:
- VIN-based billing accuracy (300 VINs included, then per-VIN charges)
- Trial limits enforcement
- Subscription management (upgrades, downgrades, cancellations)
- Invoice accuracy and payment processing
- Webhook handling for payment events
- Feature flags tied to subscription status

### 3. Documentation & Customer Success
Build comprehensive self-service resources:

**Walkthrough Tutorials:**
- Getting started / onboarding flow
- Connecting SMS integration (Tekmetric, Protractor, AutoFlow)
- Reading maintenance plans
- Using the Chrome extension
- Printing stickers and keytags
- Understanding billing

**Support Documents:**
- Troubleshooting common issues
- FAQ for each feature
- Integration-specific guides

**Knowledge Base:**
- Searchable help center
- AI chatbot training data (improves support bot responses)
- Video tutorials where helpful

**In-App Guidance:**
- Contextual tooltips
- First-time user tours
- Empty state messaging with next steps

---

## Future Integration Expansion

After post-migration priorities are complete, the normalized schema + adapter pattern enables rapid addition:

### Potential New Integrations
- Shop-Ware, Mitchell 1, R.O. Writer (SMS platforms)
- Hunter (alignment equipment data)
- Snap-on (diagnostic tool data)
- Parts ordering (WorldPac, PartsAuth, etc.)

### Integration Adapter Pattern
Each new integration implements `ISMSAdapter` interface. Data flows through existing normalized tables; backfill/prefetch/cache systems work automatically.

**Estimated time per new SMS integration:** 2-3 days (vs weeks before normalization)

### Priority Order
1. **DataOne Direct Integration (3-4 days)** - Move from external API to local PostgreSQL
2. Database Migration (9 weeks)
3. Chrome Extension Fixes
4. Stripe Billing Verification
5. Documentation & Tutorials
6. New Integrations

---

## DataOne Direct Integration Plan

### Overview
Replace external DataOne API server (EC2) with direct SFTP → PostgreSQL integration.

### Current State
- External API at `3.144.191.161:3000`
- Weekly SFTP updates (full files, not deltas)
- App calls API for VIN decoding and maintenance schedules
- MongoDB caches API responses

### Target State
- DataOne data loaded directly into PostgreSQL
- Local queries (~5ms) instead of API calls (~100-500ms)
- Weekly SFTP sync with atomic table swap (zero downtime)
- No external API dependency

### Key Tables
| Table | Purpose |
|-------|---------|
| `VIN_REFERENCE` | VIN decoding (Year/Make/Model/Engine) |
| `LKP_VIN_MAINTENANCE` | Links VIN patterns to maintenance items |
| `LKP_VIN_MAINTENANCE_INTERVAL` | Interval schedules per VIN |
| `DEF_MAINTENANCE` | Maintenance item definitions |
| `DEF_MAINTENANCE_INTERVAL` | Interval definitions (miles/months) |

### Implementation Phases
1. **Schema & Initial Load (1-2 days)** - Create PostgreSQL tables, indexes, SFTP import script
2. **Update Strategy (1 day)** - Staging table approach with atomic swap
3. **API Refactor (0.5 days)** - Update `lib/integrations/dataone-api.ts` to query local PostgreSQL
4. **Scheduled Sync (0.5 days)** - Weekly cron job for SFTP check and reload

### Required Secrets
- `DATAONE_SFTP_HOST`, `DATAONE_SFTP_PORT`, `DATAONE_SFTP_USER`, `DATAONE_SFTP_PASS`