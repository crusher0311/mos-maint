# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system aims to streamline operations for auto shops by providing tools for managing vehicle maintenance recommendations and customer data. It offers AI-powered insights, multi-shop user management, and a comprehensive dashboard for tracking customers and vehicles, ultimately enhancing shop efficiency and customer satisfaction. The project integrates with various third-party services like AutoFlow, CARFAX, DataOne, Protractor, and AutoVitals.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5 with React 18 for the frontend, leveraging Next.js API Routes for backend functionality. MongoDB Atlas serves as the cloud-hosted database, and styling is managed with Tailwind CSS. The project uses TypeScript/JavaScript.

**UI/UX Decisions:**
The application features a modern SaaS-style design with a dark sidebar (slate-900), light content areas (gray-50/white) with card-based layouts, and blue (#3B82F6 / blue-600) as the accent color. Key UI components include `Sidebar`, `AppLayout`, `LoginForm`, and `DashboardClient`. It provides a unified integrations page, a tabbed vehicle detail page, and visual data source badges for recommendations.

**Key Features:**
*   **Vehicle Analysis**: AI-powered maintenance recommendations based on vehicle history.
*   **Customer Dashboard**: Comprehensive tracking of customers and their vehicles.
*   **Multi-Shop Management**: User authentication with role-based access for multiple shops.
*   **Maintenance Planning**: Intelligent queue-based prefetching for vehicle data, configurable "Due Soon" thresholds, and display of OEM, shop, DVI, CARFAX, and Protractor recommendations.
*   **Component Tracking & Declined Services**: Advisors can track vehicle components and log declined services.
*   **Enterprise Features**: Multi-location analytics, shop management, shared canned job mappings, and revenue attribution tracking via webhooks.
*   **Platform Admin Panel**: Internal MOS staff panel for platform-wide statistics, shop management, user directory, and OpenAI API usage tracking.

**Technical Implementations:**
*   **Data Caching**: Extensive use of MongoDB Atlas for caching third-party API responses with defined TTLs.
*   **Webhook Integration**: Utilizes webhooks for real-time updates from integrations.
*   **CARFAX Mileage Interpolation**: Smart algorithm for estimating mileage.
*   **Canned Jobs (Multi-SMS)**: Syncs canned jobs from Protractor (via TimeClock API) and Tekmetric (via /canned-jobs endpoint). The settings page auto-detects which SMS is configured and shows appropriate UI. AddToROButton component supports both integrations.
*   **Shop Maintenance Intervals**: Allows shops to define custom maintenance schedules.
*   **Data Model**: `enterprise_accounts` collection with `shopIds` array; shops have `enterpriseId` field; work orders store `packageSummaries`.
*   **Authentication & Authorization**: Standardized role hierarchy (`owner`, `admin`, `manager`, `user`, `viewer`) with bcrypt password hashing and token-based setup flow.
*   **VIN-Based Billing**: Tracks "active" vehicles for billing, with configurable trial limits and platform admin controls for managing VIN allowances per shop.
*   **Stripe Billing Integration**: Checkout sessions for plan upgrades, webhook handling for subscription events, and billing portal for subscription management. Product ID: `prod_TgrceDug91whUy`.
*   **Distance Unit Preferences**: Shops can choose between miles or kilometers for displaying mileage throughout the app. Setting stored in `shops.preferences.distanceUnit`.

**Development & Deployment Workflow:**
-   **Environments**: Development (Replit), QA (GitHub `qa` branch), Production (GitHub `main` branch).
-   **Git Repository**: https://github.com/crusher0311/mos-maint.git
-   **Release Process**: Develop in Replit, push to `main`, then sync to `qa`, then tag (e.g., `git push origin main && git push origin main:qa && git tag vX.X.X && git push origin vX.X.X`).
-   **Versioning**: Semantic Versioning (MAJOR.MINOR.PATCH) is followed.

## Version History
**Current Version: v1.7.0**

| Version | Date | Summary |
|---------|------|---------|
| v1.7.0 | 2025-12-30 | Modular feature system (à la carte), Job Lookup with parts intelligence, SMS adapter architecture |
| v1.6.0 | 2025-12-30 | Protractor DVI integration, auto deep sync for canned jobs, dashboard mileage filter |
| v1.5.0 | 2025-12-29 | Workflow stage preferences for Protractor, "Inspect" item sorting, removed 30-day work order limit |
| v1.4.0 | 2025-12-29 | Vehicle detail tab renames (OE/DVI/CARFAX), CARFAX logo replacement, query param navigation |
| v1.3.0 | 2025-12-28 | Stripe billing integration, distance unit preferences, platform admin VIN limits |
| v1.2.0 | 2025-12-27 | Enterprise management system, platform admin enhancements |
| v1.1.0 | 2025-12-26 | Overdue maintenance display with red highlighting, time-based overdue calculation |
| v1.0.0 | 2025-12-25 | Initial MVP release with core features |

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe (subscriptions, billing portal)
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals (via Chrome Extension)

## Future Features

### Job Lookup / Parts Intelligence (IMPLEMENTED - v1.7.0)
**Concept:** Allow advisors to search historical work orders for parts and services, then add them to an open work order on any vehicle.
**Status:** Phase 1 complete (structured matching). AI-powered semantic matching planned for Phase 2.

**Use Case:**
1. Advisor searches "oil change 2018 Civic"
2. System finds matching historical jobs with exact parts, quantities, and pricing
3. AI scores matches based on year/make/model/engine similarity
4. Advisor selects best match and adds to current RO

**Technical Approach:**
- Index historical work order line items (parts, labor, quantities, pricing)
- Store vehicle associations (year, make, model, engine)
- Use OpenAI embeddings or structured comparison for match scoring
- Push to open work orders via existing `POST /WorkOrder/{guid}` pattern (same as canned jobs)

**Data to Extract from Work Orders:**
- Service description keywords
- Part numbers & descriptions
- Make/Model/Year/Engine associations
- Quantities and unit pricing
- Labor hours

**AI Matching:**
- Compare current vehicle (YMM/engine) against historical job vehicles
- Score by: exact match > same generation > same model > same make
- Factor in part number compatibility and service type

**AI Evolution Phases:**
1. **Phase 1 (Months 1-6): OpenAI API** - Use GPT-4 to score matches, log every query + advisor feedback as training data
2. **Phase 2 (Month 6+): Fine-Tuned Model** - After 10,000+ interactions, fine-tune GPT-3.5 or open-source model (10x cheaper)
3. **Phase 3 (Optional): Custom Model** - Train lightweight classifier that runs locally with near-zero API cost

**Data Collection for Training:**
- Log every search query
- Track which suggestions advisors view
- Record when advisor adds suggestion to RO (positive signal)
- Record when advisor ignores suggestion (negative signal)

**Implementation Notes:**
- Reuses existing Protractor work order sync data
- Same API pattern as `addServicePackageToWorkOrder()` function
- Could leverage TimeClock API for inserting individual lines

### Part Number Cross-Reference Tool (Planned)
**Concept:** Input a part number, get all compatible/interchangeable part numbers across manufacturers.

**Use Case:**
1. Advisor enters "51372" (WIX oil filter)
2. System returns: Fram PH7317, Purolator L14670, Mobil 1 M1-113, OEM 15400-PLM-A02
3. Shows pricing/availability from shop's inventory or suppliers

**Technical Approach:**
- Build cross-reference database from historical work order parts
- Use AI to identify patterns: same vehicle + same service = interchangeable parts
- Could integrate with PartsTech API for live pricing

**Data Sources:**
- Historical work orders (which parts were used on which vehicles)
- Manufacturer cross-reference databases
- AI pattern matching across shops (anonymized)

---

## Scalability Roadmap (Future Phase)
The current MVP architecture supports early-stage usage (dozens of shops, hundreds of users). To scale to thousands of concurrent users, the following improvements are needed:

**Priority 1 - Background Job System:**
- Move sync operations (Protractor, CARFAX) to a queue system (e.g., BullMQ)
- Dedicated workers for heavy processing (maintenance analysis, large aggregations)
- Job progress tracking and retry logic

**Priority 2 - Caching Layer:**
- Add Redis for session lookups (currently every request hits MongoDB)
- Cache frequently-accessed dashboard data with TTL
- Reduce database load on high-traffic routes

**Priority 3 - Database Optimization:**
- Add compound indexes on high-traffic queries
- TTL indexes for automatic session cleanup
- Consider read replicas for heavy aggregation workloads

**Priority 4 - API Rate Limiting:**
- Centralized rate limiting for Protractor/CARFAX/DataOne
- Vendor-aware throttling to prevent hitting external limits
- Batch requests where possible

**Current Limitations:**
- Sync operations run inside web requests (risk of timeouts)
- All requests hit MongoDB directly (no caching)
- Sessions stored in DB without in-memory cache
- Third-party API rate limiting is per-request, not coordinated

## Modular Feature Architecture (v1.7.0)
The platform now supports à la carte feature toggles, allowing shops to enable/disable specific tools.

**Available Features:**
- `maintenance` - OEM schedules, recommendations, DVI insights (default enabled)
- `job_lookup` - Job Lookup / History Writer - historical job search, parts intelligence
- `oil_sticker` - Oil change sticker platform (planned)
- `part_xref` - Part cross-reference tool - find interchangeable parts by part number or vehicle

**Key Files:**
- `lib/features.ts` - Feature definitions, enable/disable logic, shop_features collection
- `lib/sms-adapter.ts` - SMS abstraction interface for multi-SMS support
- `lib/sms-adapters/protractor-adapter.ts` - Protractor implementation of SMS adapter
- `app/admin/features/` - Platform admin UI for managing features per shop
- `app/api/admin/features/` - Admin API for feature management
- `app/api/shop/features/route.ts` - Get enabled features for current shop

**SMS Adapter Architecture:**
The `ISMSAdapter` interface provides abstraction for shop management systems:
- `getWorkOrders()`, `getWorkOrderById()` - Fetch work orders
- `addServicePackageToWorkOrder()` - Add jobs to work orders
- `getCannedJobs()` - Get canned job templates
- `getVehicle()`, `getVehicleByVin()` - Vehicle lookup

Currently implemented: Protractor. Future: Tekmetric, AutoFlow.

**Feature Gating:**
- Sidebar navigation items have `featureId` property
- Dashboard layout fetches enabled features and passes to Sidebar
- Sidebar filters nav items based on enabled features
- API routes can check `isFeatureEnabled(shopId, featureId)`
- **Dev Mode:** All features are auto-enabled when running in Replit dev environment (NODE_ENV=development or REPLIT_DEV_DOMAIN is set)

## Recent Changes (December 2025)
*   **v1.7.0**: Tekmetric custom label filtering - Tekmetric shops can filter dashboard by custom labels in Settings > Preferences
*   **v1.7.0**: Tekmetric history backfill - import 5 years of historical repair orders and jobs for Job Lookup feature
*   **v1.7.0**: Dashboard Workflow Stages now only shows for Protractor shops (hidden for Tekmetric)
*   **v1.7.0**: Tekmetric canned jobs support - fetch, sync, and apply canned jobs to repair orders for Tekmetric shops
*   **v1.7.0**: Multi-SMS canned jobs UI - settings page auto-detects Protractor or Tekmetric and shows appropriate interface
*   **v1.7.0**: Shop branding settings - upload shop logo for service records, add location identifier for multi-location shops
*   **v1.7.0**: Modular feature system - shops can enable/disable specific features via admin panel
*   **v1.7.0**: Job Lookup feature - search historical jobs, match scoring, add to work orders
*   **v1.7.0**: SMS adapter architecture - abstraction layer for multi-SMS support
*   **v1.6.0**: Protractor DVI integration - inspections from AutoVitals now display in vehicle detail DVI tab
*   **v1.6.0**: Auto deep sync for canned jobs - enriched library auto-populates on first load, uses cache until manually refreshed
*   **v1.6.0**: Dashboard mileage filter - only shows vehicles with mileage entered
*   Added workflow stage preferences for Protractor dashboard filtering (Settings > Preferences)
*   "Inspect" items now sort after actionable items in maintenance sections
*   Removed 30-day limitation for Protractor work orders - shows all active work orders based on stage preferences
*   Added Stripe billing integration for subscription management
*   Added distance unit preference setting (miles/kilometers)
*   Platform admin VIN limit management (default limits, per-shop overrides, reset functionality)