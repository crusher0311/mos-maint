# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system streamlines operations for auto shops by providing tools for managing vehicle maintenance recommendations and customer data. It offers AI-powered insights, multi-shop user management, and a comprehensive dashboard to enhance efficiency and customer satisfaction through integrations with industry-specific services.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application uses Next.js 14.2.5 with React 18 for the frontend and Next.js API Routes for backend functionality. MongoDB Atlas serves as the cloud-hosted database, and Tailwind CSS handles styling. The project is built with TypeScript/JavaScript.

**UI/UX Decisions:**
The design features a modern SaaS-style interface with a dark sidebar, light content areas, card-based layouts, and blue as the accent color. Key UI components include `Sidebar`, `AppLayout`, `LoginForm`, and `DashboardClient`. It includes a unified integrations page, a tabbed vehicle detail page, and visual data source badges for recommendations.

**Technical Implementations:**
*   **Data Caching**: MongoDB Atlas caches third-party API responses with defined TTLs.
*   **Webhook Integration**: Utilizes webhooks for real-time updates.
*   **CARFAX Mileage Interpolation**: Estimates vehicle mileage.
*   **Canned Jobs (Multi-SMS)**: Syncs canned jobs from Protractor and Tekmetric.
*   **Shop Maintenance Intervals**: Allows shops to define custom schedules.
*   **Data Model**: Supports `enterprise_accounts` with `shopIds` and `shops` having `enterpriseId`.
*   **Authentication & Authorization**: Role-based access (`owner`, `admin`, `manager`, `user`, `viewer`) with bcrypt password hashing and token-based setup.
*   **VIN-Based Billing**: Tracks "active" vehicles for billing, with trial limits and platform admin controls.
*   **Stripe Billing Integration**: Manages checkout sessions, webhook processing for subscriptions, and a billing portal.
*   **Distance Unit Preferences**: Shops can choose between miles or kilometers.
*   **SMS Adapter Architecture**: An `ISMSAdapter` interface provides abstraction for shop management systems (e.g., Protractor, Tekmetric).
*   **Normalized Data Layer (v1.9.1)**: SMS-agnostic data schema with provenance tracking, enabling shops to retain complete historical data when switching SMS systems. Key features:
    - 7 normalized collections (vehicles, customers, work_orders, service_jobs, payments, inspections, recommendations)
    - Bidirectional adapters for Protractor and Tekmetric
    - Dual-write ingestion in backfill and sync workers with `ingestWorkOrderBatchWithAllEntities()` method
    - Content hash-based change detection for efficient updates
    - Normalized-only query API: `/api/jobs/search-normalized` with enterprise support, algorithmic scoring, cursor pagination, and LRU caching
    - MongoDB indexes optimized for query patterns via `scripts/setup-normalized-indexes.ts`
    - In-memory query cache (`lib/normalized-cache.ts`) with TTL and LRU eviction
    - Verification tooling: `scripts/verify-normalized-data.ts` and `/api/admin/normalized-stats`

**Feature Specifications:**
*   **Vehicle Analysis**: AI-powered maintenance recommendations based on vehicle history.
*   **Customer Dashboard**: Tracks customers and their vehicles.
*   **Multi-Shop Management**: User authentication with role-based access for multiple shops.
*   **Maintenance Planning**: Intelligent queue-based prefetching, configurable "Due Soon" thresholds, and display of various recommendation sources.
*   **Component Tracking & Declined Services**: Advisors track vehicle components and log declined services.
*   **Enterprise Features**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution tracking, enterprise-wide job search, and settings replication.
*   **Platform Admin Panel**: Internal MOS staff panel for platform statistics, shop management, user directory, and OpenAI API usage tracking.
*   **Modular Feature Architecture**: Supports à la carte feature toggles for specific tools.
*   **MOS Tools Chrome Extension**: A side panel extension for Tekmetric integration, providing maintenance plans, job history search, and push-to-RO functionality.
*   **Job Lookup with Enterprise Support**: AI-scored job search across enterprise locations with prioritization for current location.

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals (via Chrome Extension)
*   **MOS Tools Chrome Extension**: Custom Chrome extension for Tekmetric integration