# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system streamlines operations for auto shops by providing tools for managing vehicle maintenance recommendations and customer data. It offers AI-powered insights, multi-shop user management, and a comprehensive dashboard to enhance efficiency and customer satisfaction through integrations with industry-specific services. The project's ambition is to provide a comprehensive, AI-enhanced platform for automotive maintenance management, improving operational efficiency and customer engagement for auto shops.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application uses Next.js 14.2.5 with React 18, Next.js API Routes, MongoDB Atlas, and Tailwind CSS, built with TypeScript/JavaScript.

**UI/UX Decisions:**
The design features a modern SaaS-style interface with a dark sidebar, light content areas, card-based layouts, and blue as the accent color. It includes a unified integrations page, a tabbed vehicle detail page, and visual data source badges for recommendations. The "My Oil Sticker" dashboard UI allows live QR code previews, color customization, and sticker downloads. A "Quick Sticker" feature provides rapid sticker printing with unit selection and service interval presets. Keytag printing features a visual designer with drag-and-drop layout editing, element styling, and live preview.

**Technical Implementations:**
*   **Data Management**: MongoDB Atlas for caching third-party API responses, state tracking, and normalized data storage.
*   **Integration Mechanisms**: Webhooks for real-time updates and an incremental sync system for shop management systems (e.g., Tekmetric, Protractor) with robust error handling, OAuth token management, and rate limiting. The integration layer is modular, enabling independent development of each integration with a unified `IIntegrationAdapter` interface and an `IntegrationFacade`.
*   **Authentication & Authorization**: Role-based access with bcrypt hashing and token-based setup.
*   **Billing & Licensing**: VIN-based billing with trial limits, Stripe integration for checkout and billing portal, and feature flags for modular functionality.
*   **Admin & Monitoring**: Comprehensive admin audit logging, unified API usage monitoring, Chrome Extension Version API, and a support ticketing system.
*   **Notification System**: Email notifications via Resend API and in-app notification bell.
*   **AI Support Chatbot**: Floating chat widget with OpenAI-powered responses, knowledge base retrieval, and ticket escalation.
*   **Sticker & Keytag Generation**: QR code generation using HoverCode API, sticker image generation via `node-html-to-image`, and Dymo label printing with a visual designer.
*   **AI & Recommendations**: AI-powered maintenance recommendations, AI-scored job search, smart job autocomplete, and a common failures advisor.
*   **SMS Adapter Architecture**: `ISMSAdapter` interface for shop management systems, enabling a normalized, SMS-agnostic data layer.
*   **Auto Booking**: A feature-gated system for automated oil change appointment scheduling.
*   **Chrome Extension**: A side panel extension integrating with Tekmetric for maintenance recommendations, job history, and sticker printing.
*   **Plan Caching**: Full plan caching in `lib/plan-cache.ts` stores assembled plan buckets (overdue, dueSoon, upcoming) for instant loads, with mileage tolerance-based invalidation.

**Feature Specifications:**
*   **Core Management**: Vehicle analysis, customer dashboard, multi-shop management.
*   **Maintenance & Service**: Intelligent queue-based prefetching for maintenance planning, component tracking, and logging declined services.
*   **Enterprise Capabilities**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution, enterprise-wide job search, and settings replication.
*   **Modular Features**: A la carte feature flags (maintenance, job lookup, common failures, oil sticker, keytags, auto booking, part cross-reference) managed via platform admin.
*   **User Preferences**: Shops can choose distance units (miles/kilometers).

## Future Work

### Robust Stripe Billing with Grace Periods
**Priority:** High | **Status:** Planned

Current webhook handles payment failures by setting status to "past_due", but lacks:
1. **Grace period tracking** - Add `pastDueSince`, `failedPaymentCount` fields to track when failures started
2. **Configurable grace period** - Add `gracePeriodDays` to billing settings (default: 7 days)
3. **Account locking** - Add "locked" billing status for accounts past grace period
4. **Feature gating update** - Modify `isBillingActive()` in `lib/featureResolver.ts` to:
   - Allow access during grace period (past_due but within X days)
   - Block access after grace period expires
5. **Failed payment notifications** - Email customers when payments fail with instructions to update payment method
6. **Daily cleanup job** - Auto-lock accounts that exceed grace period

**Files to modify:**
- `lib/stripe.ts` - Add grace period settings
- `lib/featureResolver.ts` - Update `isBillingActive()` logic
- `app/api/stripe/webhook/route.ts` - Track failure timestamps and counts
- `lib/email.ts` - Add payment failure email template

### AI Auto-Populate for Repair Orders
**Priority:** Medium | **Status:** Idea

An AI automation bot that analyzes vehicle context and automatically populates repair orders with relevant services.

**Data Sources:**
- Maintenance plan (overdue, due soon, upcoming)
- Deferred work (previously declined services)
- Common failures for year/make/model/mileage
- Shop's canned jobs

**Shop Preference Modes:**
- `off` - Feature disabled
- `suggest` - Shows recommendations, requires manual approval
- `auto` - Automatically adds to every new RO (like auto booking)

**Configuration Options:**
- Maximum items to auto-add
- Priority/confidence threshold
- Categories to include/exclude
- Manager approval for items over $X

**Implementation:**
1. Trigger on new RO creation
2. Gather all data sources for the vehicle
3. Send to OpenAI for analysis and ranking
4. Based on mode: show suggestions or auto-add items
5. Log all AI-added items for tracking

**Feature Flag:** Add `auto_populate` to existing feature flags system

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API