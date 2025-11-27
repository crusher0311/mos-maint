# MOS Maintenance MVP

## Overview
This is a Next.js-based automotive maintenance management system that helps shops manage vehicle maintenance recommendations, customer data, and integrations with third-party services like AutoFlow and CARFAX.

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
