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

See **`PROTRACTOR_REFERENCE.md`** for Protractor API integration details including labor rate calculations and line formatting.

## Recent Changes

**January 27, 2026:**
- Added `shop_media` MongoDB collection for storing logos and QR codes
- Logo uploads now stored as base64 in MongoDB (works on Render without Replit object storage)
- QR codes cached in MongoDB to reduce HoverCode API calls
- Added location identifier display to enterprise overview page

**January 26, 2026:**
- Fixed labor rate calculation when adding jobs from history - now uses 3-tier fallback (WO lines → shop job history → historical rate)
- Improved service title normalization for job search matching (singular forms for better matching)
- Fixed deferred work matching to prevent partial matches (e.g., "Cabin Air Filter" no longer matches "Air Filter")

**January 25, 2026:**
- Completed full modular architecture refactoring for integration layer (all 6 phases)
- Created foundation layer with unified `IIntegrationAdapter` interface and `IntegrationFacade`
- Split Protractor monolith (2,671 lines) into 6 focused modules (~100-500 lines each)
- Modularized Tekmetric integration with OAuth management and API client separation
- Modularized AutoFlow DVI integration with self-contained structure
- Implemented auto-registration pattern for all integration adapters
- Maintained backward compatibility through re-exports in main index

**January 24, 2026:**
- Added failsafe mechanism for Protractor backfills with stale detection (30-min threshold)
- Fixed Next.js Suspense boundary issues in setup pages using dynamic imports with `ssr: false`
- Payment-first signup flow implemented (no free trial)
- Protractor backfill runs inline on connection with adaptive chunk sizing