# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system aims to streamline operations for auto shops. It provides tools for managing vehicle maintenance recommendations and customer data, offering AI-powered insights, multi-shop user management, and a comprehensive dashboard. The system enhances shop efficiency and customer satisfaction through integrations with industry-specific services.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

**Git Workflow**: Development in Replit → push to `qa` branch for testing → user promotes to `main` (production) after QA verification. Post-MVP launch, `main` will be protected and require explicit promotion from `qa`.

## System Architecture
The application is built using Next.js 14.2.5 with React 18 for the frontend and Next.js API Routes for backend functionality. MongoDB Atlas is the cloud-hosted database, and styling is managed with Tailwind CSS. The project uses TypeScript/JavaScript.

**UI/UX Decisions:**
The application features a modern SaaS-style design with a dark sidebar, light content areas, card-based layouts, and blue as the accent color. Key UI components include `Sidebar`, `AppLayout`, `LoginForm`, and `DashboardClient`. It provides a unified integrations page, a tabbed vehicle detail page, and visual data source badges for recommendations.

**Technical Implementations:**
*   **Data Caching**: MongoDB Atlas is used for caching third-party API responses with defined TTLs.
*   **Webhook Integration**: Utilizes webhooks for real-time updates from integrations.
*   **CARFAX Mileage Interpolation**: A smart algorithm estimates mileage.
*   **Canned Jobs (Multi-SMS)**: Syncs canned jobs from Protractor and Tekmetric, with UI adapting to the configured SMS.
*   **Shop Maintenance Intervals**: Allows shops to define custom maintenance schedules.
*   **Data Model**: Supports `enterprise_accounts` with `shopIds` and `shops` having `enterpriseId`.
*   **Authentication & Authorization**: Role-based access (`owner`, `admin`, `manager`, `user`, `viewer`) with bcrypt password hashing and token-based setup.
*   **VIN-Based Billing**: Tracks "active" vehicles for billing with configurable trial limits and platform admin controls for VIN allowances.
*   **Stripe Billing Integration**: Handles checkout sessions for plan upgrades, webhook processing for subscriptions, and a billing portal.
*   **Distance Unit Preferences**: Shops can choose between miles or kilometers for mileage display.

**Feature Specifications:**
*   **Vehicle Analysis**: AI-powered maintenance recommendations based on vehicle history.
*   **Customer Dashboard**: Comprehensive tracking of customers and their vehicles.
*   **Multi-Shop Management**: User authentication with role-based access for multiple shops.
*   **Maintenance Planning**: Intelligent queue-based prefetching for vehicle data, configurable "Due Soon" thresholds, and display of OEM, shop, DVI, CARFAX, and Protractor recommendations.
*   **Component Tracking & Declined Services**: Advisors can track vehicle components and log declined services.
*   **Enterprise Features**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution tracking via webhooks, enterprise-wide job search with location badges, and copy settings between locations.
*   **Platform Admin Panel**: Internal MOS staff panel for platform-wide statistics, shop management, user directory, and OpenAI API usage tracking.
*   **Modular Feature Architecture**: Supports à la carte feature toggles (`maintenance`, `job_lookup`, `oil_sticker`, `part_xref`) allowing shops to enable/disable specific tools.
*   **SMS Adapter Architecture**: An `ISMSAdapter` interface provides abstraction for shop management systems (currently Protractor, with future support for Tekmetric, AutoFlow).
*   **MOS Tools Chrome Extension**: A side panel MV3 extension for Tekmetric integration, providing maintenance plans, job history search, and push-to-RO functionality.
*   **Job Lookup with Enterprise Support**: AI-scored job search across enterprise locations with location badges showing job source, 5-point scoring bonus for current location jobs, and vehicle/engine matching algorithms.

## Recent Changes (January 2026)
*   **v1.7.3 Updates**:
    *   **Visit-Based Billing (VIN+RO Tracking)**: Changed trial limit tracking from unique VINs to unique visits (VIN + RO# combination). Each new repair order for a vehicle now counts as a separate visit toward the trial limit. Same VIN with same RO viewed multiple times only counts once. This applies to both dashboard and Chrome extension.
    *   **Chrome Extension VIN Tracking**: Extension plan views now track against trial limits with the same VIN+RO logic. Shows upgrade prompt when limit reached.
    *   **Tekmetric Automatic Backfill Worker**: Added continuous background worker for Tekmetric historical data, matching Protractor's approach. Processes 1-month chunks every 5 minutes, storing progress in `tekmetric_backfill_progress` collection. Both integrations can now backfill simultaneously.
    *   **Platform Admin Backfill Display Fix**: Fixed Tekmetric shops showing 0 backfill - now correctly queries `job_index` collection for Tekmetric and `tekmetric_backfill_progress` for progress tracking.
    *   **Welcome Emails via Resend**: New shop owners receive a branded welcome email from noreply@mos.tools when they complete signup. Uses Resend API with mos.tools domain.
*   **v1.7.2 Updates**:
    *   **Feature Gating Fix**: Fixed critical bug where Platform Admin feature toggles (Part Cross-Ref, Job Lookup, etc.) weren't reflected in the sidebar. The `/api/shop/features` endpoint now uses the unified `featureResolver` system instead of the deprecated `shop_features` collection.
    *   **Navigation Cleanup**: Removed Reporting, Billing, and Shop Onboarding from sidebar navigation until verified with live production users. Pages still exist but are hidden from menu.
*   **v1.7.1 Updates**:
    *   **Background Sync on Connect**: Protractor and Tekmetric integrations now use fire-and-forget sync. Users see "Connected! Initial sync started in background." and can navigate away immediately without waiting for sync to complete.
    *   **Maintenance Thresholds KM Support**: The "Due Soon" thresholds page now respects shop distance unit preference, showing km-based presets and inputs for shops using kilometers.
    *   **Flexible Interval Input**: Changed mileage/km input step from 1000 to 10, allowing more precise values like 12,070 km to match OEM recommendations exactly.
    *   **Platform Admin Enterprise Grouping**: Added "Group by Enterprise" toggle to shops page with enterprise section headers, location identifier badges (blue), and improved search across shop name, location, and enterprise.
*   **Wheel Alignment Service (v1.7)**: Added Wheel Alignment as a trackable maintenance service. Now available in Shop Intervals (default: 15,000 mi / 12 mo), Canned Jobs mappings, and recommendation engine pattern matching.
*   **Maintenance Interval Exclusion & KM Support**: Shops can now exclude specific services from recommendations entirely using the new "Exclude" checkbox. When checked, that service will not appear in maintenance plans regardless of OEM data. Also added full kilometer support - shops with km preference see KM in the intervals settings page, and values are properly converted for display/storage.
*   **Setup Wizard Integration Options**: Added Tekmetric and CARFAX to the onboarding wizard. New shops can now configure all 5 integrations during signup: AutoFlow, AutoVitals, Protractor, Tekmetric, and CARFAX. The setup API route now saves all integration configurations to the shop document.
*   **Self-Service Webhook URLs (v1.6)**: Shops can now view and copy their AutoFlow webhook URL directly from Settings > Integrations. Tokens are auto-generated per shop for security. URL format: `https://mos.tools/api/webhooks/autoflow/{token}`.
*   **AutoFlow Dashboard Fix**: Fixed dashboard not showing vehicles for AutoFlow-only shops. The events collection uses `receivedAt` timestamp, but the query was filtering by `createdAt`. Now correctly queries 30 days of AutoFlow webhook events.
*   **Feature Gatekeeping System** (In Progress): Hierarchical feature resolver combining billing plans, enterprise settings, and shop overrides. Platform Admin UI for managing shop billing/features. Job Lookup API returns 402 when feature not entitled. **TODO**: Add feature controls to Enterprises page UI and shop Settings page for owners.
*   **Dashboard Page Size**: Increased from 50 to 100 vehicles per page to show all active work orders.
*   **Platform Admin Integration Detection**: Enhanced to recognize both nested (`shop.autoflow.apiKey`) and flat (`shop.autoflowApiKey`) credential field formats.
*   **Protractor VIN Fallback**: Added fallback to fetch vehicle by ServiceItemID when VIN is missing from work order response.
*   **Automatic Job History Backfill (Fixed)**: Dynamic backfill system for Protractor shops. Fixed critical issue where `/WorkOrder/` endpoint didn't include ServicePackages. Now uses `/Invoice/` endpoint which contains complete job data. Uses pLimit(10) for parallel processing of invoice details. Processes 1-month chunks with 1 shop per run for efficiency.
*   **Enterprise Location Identifiers**: Shop locations now use `locationIdentifier` field for display names (e.g., "Southern Pines", "NC 87") while `name` inherits enterprise name.
*   **Job Search Location Awareness**: Job Lookup queries all enterprise locations, displays location badges on results, and prioritizes current location with a scoring bonus.
*   **VIN Compound Index**: Changed from single-field unique to compound (shopId + vin) to support same VIN across different enterprise locations.
*   **Copy Settings Between Locations**: Enterprise admins can copy logo, canned job mappings, and maintenance thresholds between locations.
*   **Location Switcher Enhancement**: Dropdown displays location identifiers instead of primary shop names, sorted alphabetically.

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe (subscriptions, billing portal)
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals (via Chrome Extension)
*   **MOS Tools Chrome Extension**: Custom Chrome extension for Tekmetric integration