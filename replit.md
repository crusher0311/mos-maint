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
*   **Stripe Billing Integration**: Manages checkout sessions, webhook processing for subscriptions, and a billing portal. Includes webhook event logging, idempotency checking, and dead-letter queue for failed events (`stripe_webhook_events` collection).
*   **Admin Audit Logging**: Comprehensive logging of admin actions (impersonation, unlocks, settings changes) with IP/user-agent tracking via `lib/audit-log.ts` and `/api/admin/audit-logs` endpoint.
*   **Sync Worker Health Monitoring**: Adaptive backoff (10s-120s based on failures), health metrics every 10 cycles via `lib/sync-metrics.ts`, and sync status dashboard at `/api/admin/sync-health`.
*   **Chrome Extension Version API**: `/api/extension/version` endpoint for client-side update enforcement (min version 1.3.0, current 1.3.1).
*   **E2E Testing with Auth Bypass**: Automated testing infrastructure via `lib/test-auth.ts` with HMAC-signed tokens. Run tests with `npm run test:e2e`. Requires `E2E_TEST_SECRET` environment variable (16+ chars). Test utilities in `tests/e2e/`.
*   **Distance Unit Preferences**: Shops can choose between miles or kilometers.
*   **SMS Adapter Architecture**: An `ISMSAdapter` interface provides abstraction for shop management systems (e.g., Protractor, Tekmetric).
*   **Normalized Data Layer (v1.9.2)**: SMS-agnostic data schema with provenance tracking, enabling shops to retain complete historical data when switching SMS systems. Key features:
    - 7 normalized collections (vehicles, customers, work_orders, service_jobs, payments, inspections, recommendations)
    - Bidirectional adapters for Protractor and Tekmetric
    - Dual-write ingestion in backfill and sync workers with `ingestWorkOrderBatchWithAllEntities()` method
    - Content hash-based change detection for efficient updates
    - Normalized-only query API: `/api/jobs/search-normalized` with enterprise support, algorithmic scoring, cursor pagination, and LRU caching
    - MongoDB indexes optimized for query patterns via `scripts/setup-normalized-indexes.ts`
    - In-memory query cache (`lib/normalized-cache.ts`) with TTL and LRU eviction
    - Verification tooling: `scripts/verify-normalized-data.ts` and `/api/admin/normalized-stats`
    - **Raw payload preservation (v1.9.2)**: Complete API responses stored in `rawPayload` field for data recovery, future features, and debugging

**Feature Specifications:**
*   **Vehicle Analysis**: AI-powered maintenance recommendations based on vehicle history.
*   **Customer Dashboard**: Tracks customers and their vehicles.
*   **Multi-Shop Management**: User authentication with role-based access for multiple shops.
*   **Maintenance Planning**: Intelligent queue-based prefetching, configurable "Due Soon" thresholds, and display of various recommendation sources.
*   **Component Tracking & Declined Services**: Advisors track vehicle components and log declined services.
*   **Enterprise Features**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution tracking, enterprise-wide job search, and settings replication.
*   **Platform Admin Panel**: Internal MOS staff panel for platform statistics, shop management, user directory, and OpenAI API usage tracking.
*   **Modular Feature Architecture**: Supports à la carte feature toggles for specific tools.
*   **MOS Tools Chrome Extension (v1.3.0)**: A side panel extension for Tekmetric integration with 4 tabs: Plan (maintenance recommendations), Failures (Common Failures Advisor based on shop data), Lookup (job history search), and Canned Jobs. Supports push-to-RO functionality.
*   **Job Lookup with Enterprise Support**: AI-scored job search across enterprise locations with prioritization for current location.
*   **Smart Job Autocomplete**: As-you-type suggestions with historical labor hours and pricing from shop data, prioritizing vehicle-specific matches.
*   **Common Failures Advisor**: Predicts common repairs by vehicle/powertrain/mileage using a "shop data first, AI fallback" approach. Features:
    - Pre-computed `shop_repair_patterns` collection with aggregated repair data by year/make/model/mileage bucket
    - Pattern updates during sync/backfill via `dualWriteToRepairPatterns` option
    - Enterprise aggregation pools patterns across multiple shop locations (uses MongoDB ObjectId for enterpriseId)
    - Only calls AI when shop has fewer than 3 qualifying patterns (2+ occurrences each)
    - Shows data source badge: "Your Data" (shop patterns), "Mixed" (hybrid), or "AI"
    - Setup scripts: `scripts/setup-repair-patterns-indexes.ts`, `scripts/backfill-repair-patterns.ts`
    - **Type convention (Jan 2026)**: enterpriseId uses MongoDB ObjectId in database - use `toObjectId()` from `lib/object-id-utils.ts` for all queries/writes

## My Oil Sticker Integration

**Status**: Phase 2 Complete (Jan 2026) - Dashboard UI implemented

**Context**: ~290 shops using standalone My Oil Sticker product. Goal is to migrate them to MOS dashboard as a separately-billable feature toggle.

**Phase 1 - QR Code Generation (UPDATED Jan 2026)**:
Switched back to HoverCode API for better quality and tracking:

| Component | Solution | Status |
|-----------|----------|--------|
| QR Codes | HoverCode API (dynamic, tracked) | DONE |
| Sticker Images | `node-html-to-image` | DONE |

**HoverCode Integration**:
- Creates dynamic QR codes with tracking/analytics
- Supports existing QR codes via `hovercodeQRId` field (for migrated shops)
- Falls back to `qrcode` npm package if API fails
- Environment: `HOVERCODE_API_TOKEN`, `HOVERCODE_WORKSPACE_ID`

**API Endpoints**:
- `GET /api/sticker/redirect/[shopId]` - Dynamic QR redirect to shop appointment URL (tracks scans)
- `GET /api/sticker/qr?size=300&dotStyle=rounded&color=%23000000` - Styled QR code with logo overlay
- `POST /api/sticker/qr` - Styled QR code as data URL (for embedding)
- `POST /api/sticker/generate` - Generate sticker PNG (sizes: 2x2", 2x2.5", 2x3", 2x3.5")
- `GET/PUT/DELETE /api/sticker/settings` - Manage shop sticker configuration

**Styled QR Code Options** (GET params or POST body):
- `size` - Pixel dimensions (default: 300)
- `dotStyle` - "rounded" | "dots" | "classy" | "classy-rounded" | "square" | "extra-rounded"
- `color` - Hex color for QR dots (default: #000000)
- `backgroundColor` - Hex background color (default: #ffffff)
- `includeLogo` - Include center logo overlay (default: true)

**Default Logo**: `public/sticker-qr-logo.svg` - Calendar+wrench icon matching HoverCode style

**Sticker Configuration Schema** (stored in `shops.stickerConfig`):
```typescript
{
  enabled: boolean,
  logo: string,          // URL to shop logo (or proxy URL from upload)
  logoObjectPath: string,// Object storage path for uploaded logos
  phone: string,         // Shop phone number
  tagline: string,       // Custom tagline
  taglineLine2: string,  // Second tagline line
  serviceLabel: string,  // Label text (e.g., "Next Oil Service", "Service Due")
  showQRCode: boolean,   // Toggle QR code visibility
  roundMileage: boolean, // Round mileage to nearest 100
  usePredictiveDate: boolean, // Use driving habits to predict service date
  fontStyles: {          // Font styling for each text element
    phone: { bold: boolean, italic: boolean, size: number },
    tagline: { bold: boolean, italic: boolean, size: number },
    taglineLine2: { bold: boolean, italic: boolean, size: number },
    serviceLabel: { bold: boolean, italic: boolean, size: number },
    serviceValue: { bold: boolean, italic: boolean, size: number },
  },
  colors: {
    primary: string,     // Hex color for QR code dots (default: #1976d2)
    secondary: string,   // Accent color
    text: string,        // Text color
    background: string,  // Sticker background color (default: #ffffff)
    phoneColor: string,  // Phone number text color (default: #000000)
    taglineColor: string,// Tagline text color (default: #333333)
    serviceLabelColor: string, // Service label color (default: #666666)
    serviceValueColor: string, // Date/mileage color (default: #cc0000)
  },
  defaultSize: string,   // "2x2" | "2x2.5" | "2x3" | "2x3.5"
  appointmentUrl: string,// Override redirect URL
  useKilometers: boolean, // false = miles
  hovercodeQRId: string, // HoverCode QR ID for existing/migrated shops
  intervals: {           // Per-oil-type interval settings
    diesel: { mileage: number, months: number },     // Default: 7500/6
    euro: { mileage: number, months: number },       // Default: 10000/12
    synthetic: { mileage: number, months: number },  // Default: 7500/6
    conventional: { mileage: number, months: number } // Default: 3000/3
  }
}
```

**Predictive Date Calculation (Jan 2026)**:
Uses "shortest interval wins" logic:
1. Calculates fixed date: today + interval months (e.g., 5 months for synthetic)
2. Calculates predictive date: today + (interval miles / milesPerDay from CARFAX)
3. Uses whichever date comes FIRST (earliest)
- Example: 5000 miles at 98.6 mi/day = 51 days → uses Feb 26, 2026 (shorter than 5 months)
- Example: 5000 miles at 13.3 mi/day = 376 days → uses fixed 5 months (shorter than 12+ months)
- API: `GET /api/vehicle/driving-stats?vin=XXX` returns milesPerDay from CARFAX history

**Logo Upload Flow**:
- `POST /api/sticker/upload-logo` - Generate presigned URL for upload
- `POST /api/sticker/finalize-logo` - Finalize upload and save path
- `GET /api/sticker/logo/[shopId]/[filename]` - Proxy endpoint to serve logos

**Environment Variables**:
- `NEXT_PUBLIC_BASE_URL` - Required for QR code generation (set in development)

**Utility Functions**:
- `lib/sticker-utils.ts`: `getBaseUrl()`, `getStickerRedirectUrl(shopId)`

**Phase 2 - Dashboard UI (COMPLETE)**:
- Sticker settings page at `/dashboard/settings/stickers`
- Live QR code preview with color customization
- Sticker download for all sizes (2x2", 2x2.5", 2x3", 2x3.5")
- Default service interval settings (mileage/kilometers + months)
- Feature-gated sidebar navigation (`featureId: "oil_sticker"`)
- Direct logo upload to Replit Object Storage
- Full color customization: background, phone, tagline, label, and date/mileage colors
- Larger logo display (80px max height, up from 50px)

**Pending Phases**:
- Phase 3: Chrome extension merge (sticker tab in MOS Tools)
- Phase 4: Billing integration (feature toggle in platform-admin)
- Phase 5: Migration script (import existing shop settings)

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals (via Chrome Extension)
*   **MOS Tools Chrome Extension**: Custom Chrome extension for Tekmetric integration
*   **QR Code Generation**: HoverCode API (dynamic QR codes with analytics)