# MOS Maintenance MVP

## Overview
This is a Next.js-based automotive maintenance management system that helps shops manage vehicle maintenance recommendations, customer data, and integrations with third-party services like AutoFlow, CARFAX, DataOne, and Protractor.

## Tech Stack
- **Frontend**: Next.js 14.2.5 with React 18
- **Backend**: Next.js API Routes (serverless functions)
- **Database**: MongoDB Atlas (cloud-hosted)
- **Styling**: Tailwind CSS
- **Language**: TypeScript/JavaScript

## Project Structure
- `app/` - Next.js app router pages and layouts
- `app/api/` - API routes for backend functionality
- `components/` - Reusable React components
- `lib/` - Utility functions and database connections
- `public/` - Static assets
- `scripts/` - Database migration and setup scripts

## Environment Setup

### Required Environment Variables
- `MONGODB_URI` - MongoDB connection string (currently: mongodb://localhost:27017/mos-maintenance-mvp)
- `MONGODB_DB` - Database name (default: mos-maintenance-mvp)
- `SESSION_SECRET` - Secret for session management
- `ADMIN_TOKEN` - Admin access token for initial setup

### Optional Integrations
- `OPENAI_API_KEY` - For AI-powered maintenance recommendations
- `DATAONE_API_URL` - External DataOne API for VIN decoding and OEM maintenance schedules (default: http://3.144.191.161:3000)
- AutoFlow and CARFAX integrations (see .env.example for details)

## Development

### Running Locally
The dev server runs on port 5000 (configured for Replit):
```bash
npm run dev
```

### Key Features
1. **Vehicle Analysis** - AI-powered maintenance recommendations based on vehicle history
2. **Customer Dashboard** - Track customers and their vehicles
3. **AutoFlow Integration** - Sync repair orders and vehicle data
4. **Authentication** - Multi-shop user management with role-based access

## Deployment
The app is configured for Replit autoscale deployment:
- Build command: `npm run build`
- Start command: `npm run start`
- Port: 5000

## Database Collections
- `customers` - Customer records
- `vehicles` - Vehicle information
- `repair_orders` - Service repair orders
- `events` - Integration webhook events
- `users` - User accounts
- `shops` - Shop configurations
- `sessions` - User sessions
- `ai_analysis_cache` - Cached AI analysis results
- `dataone_cache` - Cached DataOne API responses (OEM maintenance schedules, 7-day TTL)
- `protractor_vehicles` - Cached Protractor ServiceItems (vehicles)
- `protractor_work_orders` - Cached Protractor work orders
- `protractor_invoices` - Cached Protractor invoices
- `protractor_deferred_work` - Cached Protractor deferred work (maintenance recommendations)
- `protractor_events` - Raw webhook events from Protractor
- `protractor_canned_jobs` - Cached Protractor canned jobs for quick access
- `canned_job_applications` - Log of canned jobs applied to work orders

## UI Design System
The application uses a modern SaaS-style design with:
- **Dark sidebar navigation** (slate-900 background) with expandable sections
- **Light content areas** (gray-50/white backgrounds) with card-based layouts
- **Blue accents** (#3B82F6 / blue-600) for primary actions and highlights
- **Tailwind CSS v4** with @import syntax instead of @tailwind directives

### Key UI Components
- `components/ui/Sidebar.tsx` - Dark navigation sidebar with search and expandable menus
- `components/ui/AppLayout.tsx` - Main layout wrapper with sidebar integration
- `app/login/LoginForm.tsx` - Modern login form with icons and validation
- `app/dashboard/DashboardClient.tsx` - Dashboard with stats cards, search, and data table

## Recent Changes
- **2024-12-21**: Protractor Canned Jobs Integration
  - **Canned Job Sync**: Fetch and cache canned jobs from Protractor API
  - **Mapping UI**: Settings > Canned Jobs page to map service keys (oil, brakes, etc.) to Protractor canned job IDs
  - **One-Click Add to RO**: Blue "Add to RO" button appears on Plan page recommendations when a mapped canned job exists
  - Clicking the button automatically finds the vehicle's open work order and applies the canned job
  - Application history logged in `canned_job_applications` collection
  - Canned jobs cached in `protractor_canned_jobs` with 6-hour TTL
  - API endpoints: `/api/protractor/canned-jobs` (list), `/api/protractor/apply-canned-job` (apply to RO)
  - Client component `AddToROButton` handles async state (loading, success, error with retry)

- **2024-12-21**: Shop Maintenance Intervals & CARFAX Mileage Interpolation
  - **Shop Intervals Override**: New Settings > Shop Intervals page allows shops to define custom maintenance schedules that override OEM recommendations
  - Shops can set custom miles/months intervals for common services (oil, tire rotation, brakes, etc.)
  - Toggle "Use Shop" checkbox to enable custom interval for each service
  - Plan page shows green "Shop" badge when using shop intervals instead of OEM
  - Data stored in `shops.maintenance.intervals` as a map keyed by service slug
  - **CARFAX Mileage Interpolation**: Smart algorithm to estimate mileage for CARFAX service records missing odometer readings
  - Interpolates between surrounding records with known mileage instead of simple backward calculation
  - Falls back to extrapolation if only one side has known mileage
  - Results in much more accurate "last done at X miles" estimates

- **2024-12-21**: Vehicle Component Tracking & Declined Services
  - **Vehicle Attribute Checkboxes**: Advisors can mark which components a vehicle has (e.g., cabin filter, timing belt) via checkboxes in the Attributes tab. Data stored in `vehicles.hasComponents` as normalized key-value pairs.
  - **Declined Services Tracking**: Track services customers have declined with reason, mileage, and date. Displayed in History tab with red "DECLINED" badge.
  - **"Previously Declined" Badge on Plan**: Recommendations that match previously declined services show an orange "Previously declined" badge with decline context.
  - **Refined Recs UI**: DVI inspection items now have cleaner visual indicators with colored left borders (red for needs attention, yellow for caution), category headers show count badges, and status labels are more prominent.
  - **API Endpoints**: `/api/vehicles/[vin]/components` (GET/PATCH) and `/api/vehicles/[vin]/declined` (GET/POST/DELETE) for managing component states and declined services.

- **2024-12-20**: Protractor Integration
  - Created lib/integrations/protractor.ts with HMAC-SHA1 authentication (verified against official sample)
  - API client supports: Locations, Contacts, ServiceItems (vehicles), WorkOrders, Invoices, DeferredWork
  - Settings page at /dashboard/settings/protractor for shop configuration
  - Test connection feature validates credentials before saving
  - Webhook handler at /api/webhooks/protractor/[token] for real-time updates
  - Protractor data cached in MongoDB collections: protractor_vehicles, protractor_work_orders, protractor_invoices, protractor_deferred_work
  - Cache TTL: 6 hours with webhook-triggered refresh
  - **Plan Page Integration**: Protractor deferred work shows as shop recommendations with purple "Protractor" badge
  - Deferred work items appear in Due Soon bucket with reason displayed
  - Prefetch endpoint warms Protractor cache alongside DataOne, AutoFlow, and CARFAX

- **2024-11-27**: Background Prefetch Queue System
  - Created lib/plan-prefetch.ts with intelligent queue-based prefetching
  - Auto-prefetches top 10 vehicles when Plan Launcher opens
  - Prioritizes work-in-progress vehicles (those without completed DVI)
  - Rate limited: max 2 concurrent requests with 300ms pacing
  - 3-day TTL on cached data matches typical vehicle board duration
  - DVI cache auto-refreshes via webhook when technician completes inspection
  - Green lightning bolt icon shows vehicles with cached data
  - Queue continuously drains until empty while respecting concurrency limits

- **2024-11-27**: Plan Launcher - Quick Access for Advisors
  - Added blue "Open Plan" button at top of sidebar for 1-click access
  - VIN search panel with autocomplete - searches customer, vehicle, or VIN
  - Recent Plans list shows last 5 vehicles (stored in browser localStorage)
  - Hover prefetch warms all caches (DataOne, AutoFlow DVI, CARFAX) before navigation
  - Client-side vehicle cache (5-min TTL) makes search instant after first load
  - Created /api/plan-prefetch endpoint that pre-loads all Plan page data sources

- **2024-11-27**: Configurable "Due Soon" Thresholds
  - Added Settings > Maintenance Thresholds page for shop-specific configuration
  - Shops can set custom miles (default: 1,000) and days (default: 30) thresholds
  - Quick presets: Conservative (1,000mi/30d), Standard (3,000mi/90d), Extended (5,000mi/180d)
  - Plan page reads shop's thresholds and uses them for triage categorization
  - Settings stored in `shops.maintenance.dueSoonMiles` and `shops.maintenance.dueSoonDays`

- **2024-11-27**: Plan Page Loading Indicator
  - Added loading.tsx for Plan and Vehicle Detail pages
  - Shows animated loading state during API calls with progress indicators
  - "Searching history, schedules, inspections..." message with color-coded status dots

- **2024-11-27**: DataOne API Caching Implementation
  - Added MongoDB Atlas caching layer for DataOne API responses in lib/integrations/dataone-api.ts
  - New `getMaintenanceScheduleCached()` function: checks Atlas cache first, falls back to API on miss
  - Cache stored in `dataone_cache` collection with 7-day TTL (OEM data rarely changes)
  - Both Plan and Attributes pages now use cached service - first load fetches from API, subsequent loads use cache
  - Removed legacy `getLocalOeFromMongo()` functions that queried non-existent local MongoDB collections
  - Significantly improved page load times - cache hits return instantly vs 8+ second API calls
  - Cache includes: squish (VIN pattern), items array, fetchedAt/expiresAt timestamps, source indicator

- **2024-11-27**: AutoFlow DVI Integration Fix
  - Fixed DVI inspection items not displaying on vehicle detail page
  - Updated DVI selection logic to prioritize sheets with category data
  - AutoFlow API returns multiple DVI sheets; code now finds the one with actual inspection items
  - Status mapping: 0 (red/needs attention), 1 (yellow/caution), 2 (green/good)
  - Inspection categories include Interior, Exterior, Engine/Drivetrain, Tire Inspection

- **2024-11-27**: CARFAX Shop Configuration
  - Added CARFAX and AutoFlow links to Settings sidebar menu
  - Enhanced CARFAX settings page with status indicators (API URL, Product Data ID, Location ID)
  - Each shop can self-configure their CARFAX Location ID via Settings > CARFAX
  - Form disabled if environment not configured (CARFAX_POST_URL, CARFAX_PDI)
  - **Admin Panel**: Added /admin/integrations/carfax for centralized management of all shop Location IDs
  - Admins can view/edit CARFAX Location IDs for any shop from one page

- **2024-11-27**: DataOne API Integration
  - Created lib/integrations/dataone-api.ts with VIN decoding and maintenance schedule functions
  - Enhanced vehicle detail page to use DataOne API for OEM maintenance schedules
  - Added fallback VIN decoding when vehicle data is incomplete
  - Set DATAONE_API_URL environment variable
  - Increased timeout to 8 seconds with MongoDB fallback

- **2024-11-27**: MongoDB Atlas Migration
  - Connected app to live MongoDB Atlas database (cloud-hosted)
  - Fixed vehicle detail page to pull data from events collection when not found in vehicles collection

- **2024-11-27**: UI Modernization
  - Redesigned login page with centered card layout and blue icon branding
  - Added dark sidebar navigation component with expandable settings menu
  - Updated dashboard with stat cards, search functionality, and modern table design
  - Created tabbed vehicle detail page with Attributes, Recs, and History tabs
  - Data source badges: OEM (blue), DVI (orange), CARFAX (purple), Shop (green)
  - Standardized design patterns across all updated components
  - Fixed Tailwind CSS v4 configuration (@import syntax)
  
- **2024-11-27**: Initial Replit setup
  - Configured Next.js to run on port 5000 with host 0.0.0.0
  - Added experimental.allowedOrigins configuration for Replit proxy
  - Configured deployment settings for autoscale
