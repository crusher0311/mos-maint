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
*   **Protractor Canned Jobs**: Syncs, allows manual entry, and provides mapping UI for canned jobs, integrating service packages via TimeClock API.
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
**Current Version: v1.5.0**

| Version | Date | Summary |
|---------|------|---------|
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

## Recent Changes (December 2025)
*   Added workflow stage preferences for Protractor dashboard filtering (Settings > Preferences)
*   "Inspect" items now sort after actionable items in maintenance sections
*   Removed 30-day limitation for Protractor work orders - shows all active work orders based on stage preferences
*   Added Stripe billing integration for subscription management
*   Added distance unit preference setting (miles/kilometers)
*   Platform admin VIN limit management (default limits, per-shop overrides, reset functionality)