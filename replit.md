# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system aims to streamline operations for auto shops. It provides tools for managing vehicle maintenance recommendations, customer data, and integrates with various third-party services such as AutoFlow, CARFAX, DataOne, Protractor, and AutoVitals. The system offers AI-powered insights, multi-shop user management, and a comprehensive dashboard for tracking customers and vehicles, ultimately enhancing shop efficiency and customer satisfaction.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5 with React 18 for the frontend, leveraging Next.js API Routes for backend functionality. MongoDB Atlas serves as the cloud-hosted database, and styling is managed with Tailwind CSS. The project uses TypeScript/JavaScript.

**Key Features:**
-   **Vehicle Analysis**: AI-powered maintenance recommendations based on vehicle history.
-   **Customer Dashboard**: Comprehensive tracking of customers and their vehicles.
-   **Multi-Shop Management**: User authentication with role-based access for multiple shops.
-   **Maintenance Planning**: Intelligent queue-based prefetching for vehicle data, configurable "Due Soon" thresholds, and display of OEM, shop, DVI, CARFAX, and Protractor recommendations.
-   **Component Tracking & Declined Services**: Advisors can track vehicle components and log declined services, which are then flagged on future recommendations.

**UI/UX Decisions:**
The application features a modern SaaS-style design.
-   **Navigation**: Dark sidebar (slate-900) with expandable sections and a quick access "Open Plan" button.
-   **Content Areas**: Light backgrounds (gray-50/white) with card-based layouts.
-   **Accent Color**: Blue (#3B82F6 / blue-600) for primary actions and highlights.
-   **Components**: Key components include a `Sidebar`, `AppLayout`, `LoginForm`, and `DashboardClient`.
-   **Unified Integrations Page**: Settings > Integrations provides a single tabbed interface for CARFAX, AutoFlow, Protractor, and AutoVitals configuration. Canned Job Mappings are accessible from the Protractor tab.
-   **Vehicle Detail Page**: Tabbed interface for Attributes, Recommendations (Recs), and History.
-   **Data Source Badges**: Visual indicators (OEM, DVI, CARFAX, Shop, Protractor) on recommendations.
-   **Loading Indicators**: `loading.tsx` for Plan and Vehicle Detail pages to show progress during API calls.

**Settings Pages (Dec 2024):**
-   **Users** (`/dashboard/settings/users`): Manage team members and pending invites with role-based permissions
-   **Billing** (`/dashboard/settings/billing`): View current plan, usage, and upgrade options
-   **Inspection** (`/dashboard/settings/inspection`): Map DVI findings to service recommendations
-   **Extensions** (`/dashboard/settings/extensions`): Manage Chrome extension API keys (owner/admin only)
-   **Workflows** (`/dashboard/settings/workflows`): Configure automated customer communications

**Dashboard Pages (Dec 2024):**
-   **Customer Workflows** (`/dashboard/workflows`): View workflow runs and delivery stats
-   **Shop Onboarding** (`/dashboard/onboarding`): Guided setup checklist for new shops

**Enterprise Features (Dec 2024):**
-   **Enterprise Dashboard** (`/admin/enterprise`): Multi-location analytics and KPI cards
-   **Shop Management** (`/admin/enterprise/shops`): Add/remove shops from enterprise accounts
-   **Shared Mappings** (`/admin/enterprise/mappings`): Configure canned job mappings across all locations
-   **Recommendation Events**: Tracks when MOS recommendations are added to repair orders
-   **Revenue Attribution**: Links sold services back to MOS recommendations for ROI tracking
-   **Data Model**: `enterprise_accounts` collection with `shopIds` array; shops have `enterpriseId` field

**Technical Implementations:**
-   **Data Caching**: Extensive use of MongoDB Atlas for caching third-party API responses (DataOne, Protractor, AutoVitals, CARFAX) with defined TTLs to improve performance.
-   **Webhook Integration**: Utilizes webhooks for real-time updates from integrations like Protractor.
-   **CARFAX Mileage Interpolation**: Smart algorithm for estimating mileage in CARFAX service records.
-   **Protractor Canned Jobs**: Syncs, allows manual entry, and provides mapping UI for canned jobs, enabling advisors to easily add them to repair orders. Service packages are inserted via TimeClock API using proper line type mapping (LaborLine, PartLine, SubletLine, OtherLine). The `UpdateWorkOrderPackage` and `UpdateWorkOrderLine` settings are automatically enabled when connecting Protractor.
-   **Protractor Sync**: The "Sync Now" button imports vehicles from recent work orders and syncs all service package templates (canned jobs) with full parts/labor line details.
-   **Shop Maintenance Intervals**: Allows shops to define custom maintenance schedules that override OEM recommendations.
-   **Environment Configuration**: Configured for Replit with specific port settings and allowed origins.

## External Dependencies
-   **Database**: MongoDB Atlas
-   **AI**: OpenAI API (for AI-powered maintenance recommendations)
-   **VIN Decoding & OEM Schedules**: DataOne API
-   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
-   **Vehicle History Reports**: CARFAX
-   **Digital Vehicle Inspections (DVI)**: AutoVitals

## Tekmetric Integration
The Tekmetric integration syncs vehicles, customers, and repair orders from Tekmetric shop management system:
-   **Authentication**: MOS uses a vendor API Bearer Token (TEKMETRIC_API_TOKEN secret). Users only need to enter their Shop ID.
-   **Production Endpoint**: `https://shop.tekmetric.com/api/v1`
-   **Features**: Vehicle sync with VIN, mileage, and customer data; Repair order access
-   **Configuration**: Settings > Integrations > Tekmetric tab
-   **Files**: `lib/tekmetric.ts`, `app/api/settings/tekmetric/route.ts`, `app/api/tekmetric/sync/route.ts`
-   **Note**: AutoVitals tab is currently hidden pending VIN data access clarification from the vendor

## Chrome Extension (AutoVitals Integration)
The `chrome-extension/` folder contains a Chrome extension that integrates with AutoVitals:
-   **Side Panel**: Displays OEM maintenance schedule, CARFAX history, maintenance plan, and DVI results for the current vehicle being viewed in AutoVitals
-   **VIN Detection**: Automatically detects the vehicle VIN from the AutoVitals page using DOM heuristics
-   **Vehicle Sync**: Imports vehicles from AutoVitals dashboard pages into MOS
-   **API Keys**: Extension uses dedicated API keys (mos_av_*) stored in shop.autovitalsExtension.apiKeys
-   **Files**: manifest.json, sidepanel.html/js, content.js, background.js, popup.html/js

## Recent Technical Changes (Dec 2024)

### Active Vehicles Only (VIN-Based Billing)
-   **Active Status Tracking**: Vehicles now have a `status` field with `active`, `sources`, and `lastClosedAt`
-   **Sources Array**: Tracks which open work orders make a vehicle "active" (provider, workOrderId, workOrderNumber)
-   **Billing Counts Only Active**: VIN billing counts only vehicles where `status.active = true`
-   **Automatic Deactivation**: When all work orders for a vehicle are invoiced/closed, the vehicle becomes "archived"
-   **Dashboard Filter**: "Show Archived" toggle button to view previously active vehicles
-   **Sync Behavior**: Protractor and Tekmetric sync only import vehicles from open work orders (not historical)
-   **Close Endpoint**: `/api/vehicles/close-work-order` removes sources and sets `active=false` when no sources remain

### Billing & Pricing (Dec 2024)
-   **Free Trial**: 25 active vehicles (VIN-based, not time-based)
-   **Professional Plan**: $199/month for unlimited vehicles
-   **Multi-Shop Plan**: $149/location/month for 3+ locations
-   **Protractor Positioning**: "The Only Maintenance Tool for Protractor Shops"

### Performance Optimizations
-   **Tekmetric Caching**: 2-minute cache for dashboard data stored in `tekmetric_cache` collection
-   **MongoDB Indexes**: Added compound indexes on key collections:
    - `vehicles`: (vin, updatedAt), (shopId, createdAt)
    - `repair_orders`: (vin, updatedAt), (shopId, createdAt)
    - `events`: (vin, updatedAt), (shopId, provider, createdAt)
    - `tekmetric_cache`: TTL index (2 minutes)
    - `dataone_cache`, `carfax_cache`: VIN indexes
-   **Index Script**: `scripts/add-indexes.ts` to recreate indexes if needed

### Bug Fixes
-   **Mileage Resolution**: Now checks `mileage` field (Tekmetric format) in addition to `odometer` and `lastMileage`
-   **Duplicate React Keys**: Plan page uses `uniqueKey` combining `serviceKey` with `maintenance_id` to prevent duplicate key warnings
-   **ShopId Consistency**: All vehicle storage uses `String(shopId)` for consistent querying

### Type Improvements
-   **VehicleDetailClient**: Proper TypeScript interfaces for DviResult, CarfaxResult, RepairOrderSummary, OemItem, TekmetricDvi
-   **Tekmetric DVI**: Now receives and displays Tekmetric inspection data when available

### Authentication & Authorization (Dec 2024)
-   **Role Hierarchy**: Standardized roles - `owner` (shop superuser), `admin` (platform staff), `manager`, `user`, `viewer`
-   **Setup Flow**: New shops go through `/setup` wizard; invited users complete via token-based `/setup?token=...`
-   **Password Hashing**: All routes now use bcrypt (cost factor 12); login handles legacy scrypt/plaintext with auto-upgrade
-   **Session Consistency**: All auth routes use `session_token` cookie with consistent options
-   **Invite Permissions**: Both `owner` and `admin` roles can invite users

## Known Limitations
-   **Tekmetric ROs without VIN**: Repair orders without VINs (e.g., #4084, #4100) cannot be displayed
-   **Tekmetric Inspections API**: Endpoint may return 404 if not enabled for the API token