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
*   **Integration Mechanisms**: Webhooks for real-time updates and an incremental sync system for shop management systems (e.g., Tekmetric, Protractor) with robust error handling, OAuth token management, and rate limiting.
*   **Authentication & Authorization**: Role-based access with bcrypt hashing and token-based setup.
*   **Billing & Licensing**: VIN-based billing with trial limits, Stripe integration for checkout and billing portal, and feature flags for modular functionality.
*   **Admin & Monitoring**: Comprehensive admin audit logging, unified API usage monitoring across all external services, Chrome Extension Version API, and a support ticketing system for customer issue management with email and in-app notifications.
*   **Notification System**: Email notifications via Resend API and in-app notification bell with real-time polling. Notifications for ticket creation, status updates, and new messages. Admin notifications distributed to SUPER_ADMINS list.
*   **AI Support Chatbot**: Floating chat widget with OpenAI-powered responses, knowledge base retrieval from resolved tickets, chat session persistence, and ticket escalation path. Admins can save ticket resolutions to the knowledge base for AI learning.
*   **Sticker & Keytag Generation**: QR code generation using HoverCode API, sticker image generation via `node-html-to-image`, and Dymo label printing for keytags with a visual designer.
*   **AI & Recommendations**: AI-powered maintenance recommendations, AI-scored job search, smart job autocomplete, and a common failures advisor leveraging shop data and AI.
*   **SMS Adapter Architecture**: `ISMSAdapter` interface for shop management systems, enabling a normalized, SMS-agnostic data layer with provenance tracking and dual-write ingestion.
*   **Auto Booking**: A feature-gated system for automated oil change appointment scheduling, including lead time configuration, holiday/business hour management, and a review queue, with a trigger from sticker printing.
*   **Chrome Extension**: A side panel extension integrating with Tekmetric for maintenance recommendations, common failures, job history search, canned jobs, and oil change sticker printing.

**Feature Specifications:**
*   **Core Management**: Vehicle analysis, customer dashboard, multi-shop management.
*   **Maintenance & Service**: Intelligent queue-based prefetching for maintenance planning, component tracking, and logging declined services.
*   **Enterprise Capabilities**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution, enterprise-wide job search, and settings replication.
*   **Modular Features**: A la carte feature flags (maintenance, job lookup, common failures, oil sticker, keytags, auto booking, part cross-reference) managed via platform admin.
*   **User Preferences**: Shops can choose distance units (miles/kilometers).

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API

## Future Implementations

### SSO (Single Sign-On) - Planned for Later
Two SSO approaches identified for future development:

**1. SAML SP (Service Provider) - For Enterprise Shops**
- Let enterprise shops use existing identity providers (Azure AD, Okta, Google Workspace)
- Employees log into MOS Tools with company credentials
- MOS acts as Service Provider accepting logins from shop's IdP
- Benefits: Centralized access control, auto-disable on employee departure
- Priority for multi-location enterprise customers with existing IT infrastructure

**2. OAuth 2.0 Provider - For Partner Apps (AppFueled, etc.)**
- Partner apps can offer "Login with MOS Tools"
- Users authorize access without sharing passwords
- Scope-based permissions (profile, shop:read, appointments:write)
- Endpoints needed: /oauth/authorize, /oauth/token, /oauth/userinfo
- Partner app registration system required

**Implementation Order:** SAML first (enterprise shops already have IdPs), OAuth second (partner ecosystem)

## Integration Modular Architecture (Completed)

The integration layer has been refactored into a modular architecture enabling independent development of each integration.

**Directory Structure:**
```
lib/integrations/
├── core/               # Foundation layer
│   ├── types.ts        # IIntegrationAdapter interface, Result<T>, normalized types
│   ├── facade.ts       # IntegrationFacade, IntegrationRegistry
│   ├── rate-limiter.ts # Shared rate limiting utilities
│   └── index.ts
├── protractor/         # Self-contained Protractor module
│   ├── types.ts        # Protractor-specific types
│   ├── client.ts       # API client and auth resolution
│   ├── transform.ts    # Protractor → Normalized data transformers
│   ├── adapter.ts      # IIntegrationAdapter implementation
│   └── index.ts        # Auto-registers with facade
├── tekmetric/          # Self-contained Tekmetric module
│   ├── types.ts        # Tekmetric-specific types
│   ├── auth.ts         # OAuth token management
│   ├── client.ts       # API client functions
│   ├── adapter.ts      # IIntegrationAdapter implementation
│   └── index.ts        # Auto-registers with facade
├── autoflow/           # Self-contained AutoFlow DVI module
│   ├── types.ts        # DVI-specific types
│   ├── client.ts       # API client for DVI fetching
│   ├── adapter.ts      # IIntegrationAdapter implementation
│   └── index.ts        # Auto-registers with facade
└── index.ts            # Main exports, auto-registers all adapters
```

**Key Patterns:**
- **Unified Interface**: All adapters implement `IIntegrationAdapter` with standard methods
- **Auto-Registration**: Each adapter registers itself with `integrationRegistry` on import
- **Integration Facade**: `integrationFacade.getConfiguredAdapter(shopId)` returns active adapter
- **Backward Compatibility**: Legacy exports maintained via re-exports from main index

**Usage:**
```typescript
import { integrationFacade, integrationRegistry } from '@/lib/integrations';

// Get configured adapter for a shop
const adapter = await integrationFacade.getConfiguredAdapter(shopId);

// Or use specific adapter
import { protractorAdapter } from '@/lib/integrations/protractor';
const vehicle = await protractorAdapter.getVehicleByVin(shopId, vin);
```

**Benefits:**
- Independent development: Work on Tekmetric without affecting Protractor
- Clear boundaries: Each integration is self-contained
- Consistent API: All adapters follow the same interface
- Easy testing: Mock individual adapters independently

See **`TECHNICAL_DEBT_REVIEW.md`** for original analysis and phase plan.

### Deprecated Files

Legacy integration files have been marked as deprecated but remain functional for backward compatibility. See **`DEPRECATED.md`** for the complete list and migration guide.

**When modifying integration code:**
1. **New features** → Add to the modular structure (`lib/integrations/{provider}/`)
2. **Bug fixes** → Fix in both legacy AND modular if both are still used
3. **Refactoring** → Work in modular structure only

**Quick reference for deprecated files:**
- `lib/integrations/protractor.ts` → Use `lib/integrations/protractor/`
- `lib/tekmetric.ts` → Use `lib/integrations/tekmetric/`
- `lib/integrations/autoflow.ts` → Use `lib/integrations/autoflow/`

## Recent Changes

**January 25, 2026:**
- Completed full modular architecture refactoring for integration layer (all 6 phases)
- Created foundation layer with unified `IIntegrationAdapter` interface and `IntegrationFacade`
- Split Protractor monolith (2,671 lines) into 6 focused modules (~100-500 lines each)
- Modularized Tekmetric integration with OAuth management and API client separation
- Modularized AutoFlow DVI integration with self-contained structure
- Implemented auto-registration pattern for all integration adapters
- **Migrated all ~30 API routes** from legacy to modular import paths
- Implemented "legacy as backing implementation" pattern: modular indexes re-export from legacy files
- Removed runtime deprecation warnings (no longer needed with modular imports throughout)
- Standardized admin panel colors to mos-blue (#3C81C3) brand color
- **Repository Pattern Abstraction**: Created `lib/data/repositories/` with BaseRepository, ShopRepository, JobIndexRepository, VehicleCacheRepository, SyncStateRepository, TekmetricTokenRepository for type-safe MongoDB access
- **Shared Sync Framework**: Created `lib/integrations/core/sync/` with SyncProvider interface and SyncRunner for unified pagination, timeboxing, and state management
- **Unit Test Infrastructure**: Added vitest configuration with 19 passing tests covering repositories, sync runner, and integration adapters
- **Migrated modular integration files to use repositories**: Protractor client.ts, Tekmetric auth.ts and adapter.ts now use repository pattern instead of direct getDb() calls
- **SMS Adapter Consistency (Issue #3)**: Created TekmetricAdapter and AutoFlowAdapter implementing ISMSAdapter interface; all three SMS providers now have consistent adapter implementations registered with SMSAdapterRegistry
- **Feature Flag Consolidation (Issue #5)**: Updated lib/features.ts to delegate isFeatureEnabled() and getEnabledFeatures() to the central featureResolver.ts, eliminating duplicate feature checking logic
- **Rate Limiting Abstraction (Issue #7)**: Migrated legacy lib/integrations/protractor.ts and lib/tekmetric.ts to use shared acquireRateLimitSlot from lib/integrations/core/rate-limiter.ts
- **Debug Logging Cleanup (Issue #12)**: Replaced ~80 console.log statements in protractor.ts and tekmetric.ts with `debugLog()` pattern. Controlled by PROTRACTOR_DEBUG/TEKMETRIC_DEBUG env vars (disabled by default)
- **Structured Logging**: Added Pino-based structured logging (`lib/logger.ts`) with JSON output, log levels, and correlation IDs
- **In-Memory Caching**: Added NodeCache-based caching layer (`lib/cache.ts`) for VIN decode, maintenance schedules, shop configs, and API responses
- **Health Check Endpoint**: Enhanced `/api/health` with MongoDB, cache, and memory checks returning detailed system status
- **MongoDB Index Audit**: Created `lib/db-indexes.ts` with 25+ optimized indexes for job_index, vehicle_cache, work_orders, users, and more
- **Background Job Queue**: Added `lib/job-queue.ts` with priority queuing, retry logic, exponential backoff, and stale job recovery
- **OpenAPI Documentation**: Created `lib/openapi.ts` with OpenAPI 3.0.3 spec for key endpoints, served at `/api/docs/openapi.json`
- **E2E Test Coverage**: Added `tests/e2e/critical-flows.test.ts` for health check, authentication, and API documentation tests
- **Performance Optimization - N+1 Query Fix**: Refactored admin/shops endpoint from 5 countDocuments per shop to single aggregation with $lookup
- **Performance Optimization - Parallel API Calls**: Vehicle-analyzer now fetches DVI, CARFAX, and OEM data in parallel instead of sequentially
- **Performance Optimization - OEM Caching**: Added 24-hour cache for OEM maintenance schedule lookups (expensive aggregation)
- **Query Monitoring**: Added `lib/query-monitor.ts` with slow query detection (>500ms), wired into BaseRepository. Admin endpoint at `/api/admin/query-stats`
- **MongoDB Index Initialization**: Created `scripts/init-indexes.ts` for running index creation; 12 new indexes added to high-traffic collections

**January 24, 2026:**
- Added failsafe mechanism for Protractor backfills with stale detection (30-min threshold)
- Fixed Next.js Suspense boundary issues in setup pages using dynamic imports with `ssr: false`
- Payment-first signup flow implemented (no free trial)
- Protractor backfill runs inline on connection with adaptive chunk sizing