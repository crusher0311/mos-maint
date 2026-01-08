# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system streamlines operations for auto shops by providing tools for managing vehicle maintenance recommendations and customer data. It offers AI-powered insights, multi-shop user management, and a comprehensive dashboard to enhance efficiency and customer satisfaction through integrations with industry-specific services. The project's ambition is to provide a comprehensive, AI-enhanced platform for automotive maintenance management, improving operational efficiency and customer engagement for auto shops.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application uses Next.js 14.2.5 with React 18, Next.js API Routes, MongoDB Atlas, and Tailwind CSS, built with TypeScript/JavaScript.

**UI/UX Decisions:**
The design features a modern SaaS-style interface with a dark sidebar, light content areas, card-based layouts, and blue as the accent color. It includes a unified integrations page, a tabbed vehicle detail page, and visual data source badges for recommendations. The "My Oil Sticker" dashboard UI allows live QR code previews, color customization, and sticker downloads. A "Quick Sticker" feature provides rapid sticker printing with unit selection and service interval presets.

**Technical Implementations:**
*   **Data Caching**: MongoDB Atlas caches third-party API responses with defined TTLs.
*   **Webhook Integration**: Utilizes webhooks for real-time updates.
*   **Canned Jobs**: Syncs canned jobs from Protractor and Tekmetric.
*   **Shop Maintenance Intervals**: Allows shops to define custom schedules.
*   **Authentication & Authorization**: Role-based access with bcrypt hashing and token-based setup.
*   **VIN-Based Billing**: Tracks "active" vehicles for billing, with trial limits and platform admin controls.
*   **Stripe Billing Integration**: Manages checkout sessions, webhook processing, and a billing portal, including logging and idempotency.
*   **Admin Audit Logging**: Comprehensive logging of admin actions (impersonation, unlocks, settings changes) with IP/user-agent tracking.
*   **Sync Worker Health Monitoring**: Adaptive backoff and health metrics.
*   **Chrome Extension Version API**: Enforces minimum client-side extension versions.
*   **E2E Testing with Auth Bypass**: Automated testing infrastructure.
*   **Distance Unit Preferences**: Shops can choose between miles or kilometers.
*   **SMS Adapter Architecture**: `ISMSAdapter` interface for shop management systems (e.g., Protractor, Tekmetric).
*   **Normalized Data Layer**: SMS-agnostic data schema with provenance tracking, 7 normalized collections, bidirectional adapters, dual-write ingestion, content hash-based change detection, and a normalized-only query API with enterprise support and caching. Raw API payloads are preserved.
*   **My Oil Sticker Integration**:
    *   QR Code Generation using HoverCode API for dynamic, tracked QR codes.
    *   Sticker image generation using `node-html-to-image`.
    *   API endpoints for dynamic QR redirects, styled QR code generation, sticker PNG generation, and sticker configuration management.
    *   Configurable sticker schema including logo, phone, taglines, service labels, QR visibility, mileage rounding, predictive date, font styles, colors, default size, appointment URL, unit preference, HoverCode ID, and per-oil-type intervals.
    *   Predictive date calculation uses CARFAX `milesPerDay` and "shortest interval wins" logic.
    *   Logo upload flow with presigned URLs and proxy serving.
    *   Chrome Extension API for fetching sticker config and generating stickers as base64 data URLs for printing.
    *   Sticker generation tracking for billing with monthly/total counts in platform-admin.
*   **Tekmetric Sync**:
    *   Initial sync triggers automatically when shop completes Tekmetric setup.
    *   Supports both `tekmetric.shopId` and legacy `tekmetricShopId` configurations.
    *   Shop ID validation on signup prevents invalid configurations.
    *   Sync via webhooks (real-time) or incremental sync worker (60-second cycles).
    *   **OAuth Token Management** (`lib/tekmetric-auth.ts`):
        *   Automatic token refresh using client credentials flow (TEKMETRIC_CLIENT_ID, TEKMETRIC_CLIENT_SECRET).
        *   Token cached in memory and persisted to MongoDB (`tekmetric_tokens` collection).
        *   Auto-refresh on 401 errors with single retry.
        *   Tokens expire after 55 minutes (with 5-minute refresh buffer).
    *   **Incremental Sync System** (`lib/tekmetric-incremental-sync.ts`):
        *   Per-shop sync state tracking (lastSyncCursor, overflowQueue, lastClosedSweepAt).
        *   Uses `updatedDateStart` filter to fetch only recently modified ROs.
        *   Vehicle/customer caching with 24-hour TTL (`tekmetric_vehicle_cache`, `tekmetric_customer_cache` collections).
        *   Concurrent batch processing (5 shops per batch) with small stagger delays.
        *   Overflow page queue (up to 20 pages) for handling large data bursts.
        *   Terminal status sweep deferred to every 15 minutes when queue is empty.
        *   Auth failure circuit breaker: auto-pauses shop sync for 1 hour after 3 consecutive 401 errors.
        *   Targets 50-150 API requests/min (down from 1000-2000 req/min with full sync).
*   **Unified API Usage Monitoring** (Platform Admin):
    *   Tracks all external API calls: Tekmetric, CARFAX, DataOne, OpenAI, Protractor, AutoFlow, HoverCode.
    *   Real-time usage gauges: requests/min, requests/sec, usage %, latency.
    *   Automatic throttling at 85% capacity, circuit breaker at 95% (Tekmetric/Protractor).
    *   Dashboard shows top shops by usage, error rates, hourly trends per provider.
    *   MongoDB collection `api_usage` with 7-day TTL auto-cleanup.
    *   API endpoint: `/api/platform-admin/api-usage` (all providers) or `?provider=tekmetric` for specific.

**Feature Specifications:**
*   **Vehicle Analysis**: AI-powered maintenance recommendations based on vehicle history.
*   **Customer Dashboard**: Tracks customers and their vehicles.
*   **Multi-Shop Management**: User authentication with role-based access for multiple shops.
*   **Maintenance Planning**: Intelligent queue-based prefetching, configurable "Due Soon" thresholds, and display of various recommendation sources.
*   **Component Tracking & Declined Services**: Advisors track vehicle components and log declined services.
*   **Enterprise Features**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution, enterprise-wide job search, and settings replication.
*   **Platform Admin Panel**: Internal MOS staff panel for platform statistics, shop management, user directory, and OpenAI API usage tracking.
*   **Modular Feature Architecture**: Supports à la carte feature toggles.
*   **MOS Tools Chrome Extension**: A side panel extension for Tekmetric integration with Plan (maintenance recommendations), Failures (Common Failures Advisor), Lookup (job history search), Canned Jobs, and Sticker (oil change sticker printing), supporting push-to-RO functionality. The Sticker tab allows quick printing with auto-populated mileage from current RO context.
*   **Job Lookup with Enterprise Support**: AI-scored job search across enterprise locations.
*   **Smart Job Autocomplete**: As-you-type suggestions with historical labor hours and pricing.
*   **Common Failures Advisor**: Predicts common repairs by vehicle/powertrain/mileage using a "shop data first, AI fallback" approach, utilizing pre-computed `shop_repair_patterns` and enterprise aggregation.

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API