# MOS Maintenance MVP

## Overview
This project is an AI-enhanced automotive maintenance management system designed to optimize operations for auto shops. Built with Next.js, it provides tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. The system aims to boost operational efficiency and customer engagement through an intuitive dashboard, various integrations, and AI-powered insights.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, with TypeScript/JavaScript. Data management is transitioning from MongoDB Atlas to PostgreSQL for core relational data, with MongoDB Atlas currently used for caching.

**UI/UX Decisions:**
The user interface features a modern SaaS design with a dark sidebar, light content areas, and card-based layouts, accented with blue. Key elements include a unified integrations page, tabbed vehicle detail pages, visual data source badges, and dedicated UIs for "My Oil Sticker" and "Quick Sticker" with customization and rapid printing. Keytag printing includes a visual designer with drag-and-drop editing and live preview. The Health Intelligence plan page displays OE manufacturer logos, dynamic Year/Make/Model titles, and "Vehicle Health Intelligence" branding. VIN tooltips show service-relevant specifications.

**Technical Implementations:**
*   **Data Management**: Core data is migrating to PostgreSQL (Supabase), with MongoDB Atlas used for caching. Plan caching uses mileage tolerance-based invalidation. DataOne OEM maintenance data is stored in Supabase PostgreSQL, updated via weekly SFTP sync.
*   **Integration Mechanisms**: A modular integration layer supports shop management systems (e.g., Tekmetric, Protractor, Shop-Ware) using `IIntegrationAdapter` and `IntegrationFacade` patterns, incorporating webhooks, incremental sync, OAuth, and rate limiting. Shop-Ware integration is fully implemented, including webhooks, daily incremental sync, and API for webhook management.
*   **Authentication & Authorization**: Role-based access with bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: VIN-based billing with Stripe integration, modular feature flags, and robust grace period handling. Supports various plan tiers, automatic mapping of BrandPro subscriptions, and CRM auto-provisioning for new shop/user creation via Stripe webhooks or admin API.
*   **Admin & Monitoring**: Includes admin audit logging, unified API usage monitoring, a support ticketing system, and a platform observability page for streamed log viewing and API usage analytics.
*   **Notification System**: Supports email notifications via Resend API and in-app notifications.
*   **AI Support Chatbot**: A floating chat widget provides OpenAI-powered responses, knowledge base retrieval, and ticket escalation.
*   **Sticker & Keytag Generation**: QR codes are generated using HoverCode API, and sticker/keytag images are rendered via `node-canvas` for fast, dependency-free generation. Supports Dymo label printing with a visual designer.
*   **Chrome Extension Shop-Ware Support**: The extension (`v1.20.13`) supports Shop-Ware for context detection, adding canned jobs, and adding findings directly to repair orders using Shop-Ware's internal APIs.
*   **AI & Recommendations**: Offers AI-powered maintenance recommendations, AI-scored job search, smart job autocomplete, and a common failures advisor.
*   **Auto Booking**: A feature-gated system for automated oil change appointment scheduling.
*   **OEM-CARFAX Service Mappings**: A platform admin page allows mapping OEM maintenance items to CARFAX service equivalents, stored in MongoDB.
*   **Chrome Extension (Detect Dog)**: The side panel extension (`v1.22.16`) supports Tekmetric, Shop-Ware, and AutoFlow, providing maintenance recommendations, job history, sticker printing, labor rate rules, and CARFAX-based mileage estimation. It includes a customer concern assistant powered by AI for intake, follow-up questions, conversation review, and cleaned write-up output, directly integrated into SMS concern fields. The extension supports multi-shop environments by aggregating user's shop IDs and resolving shop context via query parameters.
*   **Work Order Creation**: A multi-step wizard for creating Protractor work orders from the dashboard, integrating the Customer Concern Assistant, AI-scored job search, and forms for new customer/vehicle creation with VIN/license plate photo recognition.
*   **User Preferences**: Shops can select preferred distance units (miles/kilometers).
*   **Vehicle Health Report (VHR)**: A customer-facing, mobile-friendly shareable report page at `/report/[vin]`. Displays a health score gauge (0–100), overdue items with detail cards, "Systems in Good Condition" section, service timeline (NOW / NEXT 3 MO / LATER), and due-soon detail cards. Share links are generated via POST to `/api/report/[vin]` with signed, expiring tokens (15-day TTL, HMAC-SHA256). Demo page at `/report/demo`. Components in `components/vehicle-health-report/`.
*   **VHI API Endpoint**: Two versions: `GET /api/vehicles/[vin]/vhi` (session-authenticated, internal) and `GET /api/external/vehicles/[vin]/vhi` (API-key-authenticated, external). Both return Vehicle Health Indicator data as JSON — health score (0–100 with tier label), vehicle info, and bucketed maintenance items (overdue/dueSoon/upcoming/complimentary). External endpoints also return a `reportUrl` — a signed, shareable Vehicle Health Report link (15-day expiry) that partners can display to customers. Shared scoring logic in `lib/vhi-score.ts`. Report URL generation in `lib/report-share.ts`. Reads from cached plan data.
*   **VHI On-Demand Analysis**: `POST /api/external/vhi/analyze` accepts VIN + SMS type + SMS shop ID + optional RO# and mileage. Resolves the shop via `findShopBySmsId`, pulls mileage from the RO if not provided, invalidates stale cache, triggers a full plan build, and returns scored VHI results. Uses `vehicles:read` permission. Supports both shop-scoped and partner API keys. Documented in Swagger under "Vehicle Health" tag.
*   **Partner API Keys**: Global API keys (`mos_partner_...`) not bound to a single shop, designed for integration partners (e.g., AppFueled). The shop is resolved per-request via `sms` + `smsShopId` parameters. Generated by platform admins via `POST /api/platform-admin/partner-keys`. Uses enterprise-tier rate limits. Partner keys stored in `api_keys` collection with `isPartner: true`, `partnerId`, and `partnerName` fields. The `ExternalApiContext` in the middleware includes `isPartner` and `partnerId` so endpoints can handle partner vs shop-scoped keys. Platform admin UI at `/platform-admin/partner-keys` for creating, viewing, revoking, and reactivating partner keys. Revoked keys are blocked by `validateApiKey` middleware. PATCH endpoint supports `revoke` and `reactivate` actions.
*   **Partner Shops Endpoint**: `GET /api/external/shops` returns shops accessible to the API key. For shop-scoped keys, returns only that key's shop. For partner keys, returns all active shops with pagination (`page`, `limit`), search by name/location, and `sms` provider filter. Response includes `shopId`, `name`, `integrationProvider`, `locationIdentifier`, and `smsIds` (provider-specific IDs like `tekmetricShopId`, `shopwareShopId`, etc.). Requires `shops:read` permission. Documented in Swagger under "Shops" tag.
*   **VHI Auto-Build on RO Create**: All three webhook handlers (Tekmetric, Shop-Ware, Protractor) now automatically trigger a VHI build when a work order is created or updated with a valid VIN and mileage, even if the vehicle was never viewed in the dashboard or extension. The build skips if a valid plan already exists (no invalidation). Logged to `vhi_analysis_log` with `triggeredBy: "webhook_ro_create"`. Core function: `triggerVhiOnWorkOrderCreate` in `lib/vhi-webhook-trigger.ts`. This enables CRM partners like AppFueled to pull VHI data for any vehicle immediately after an RO is opened.
*   **VHI Auto-Rebuild on RO Close**: All three webhook handlers also trigger a VHI rebuild when a work order reaches a terminal/invoiced state. The rebuild invalidates the cached plan, resolves mileage from the RO, builds a fresh VHI, and logs the result (including authorized jobs) to `vhi_analysis_log`. Runs asynchronously (fire-and-forget) to avoid blocking webhook responses. Core logic in `lib/vhi-rebuild.ts` and `lib/vhi-webhook-trigger.ts`.
*   **Swagger UI**: Interactive API documentation at `/docs` (page) and `/api/docs/ui` (standalone HTML). Swagger UI assets served locally from `public/swagger-ui/`. OpenAPI spec at `/api/docs`.

**Feature Specifications:**
*   **Core Management**: Vehicle analysis, customer dashboards, and multi-shop management.
*   **Common Maintenance Layer**: Industry-standard maintenance items (wheel alignment, power steering fluid, shocks/struts, battery, wiper blades, fuel system cleaning, coolant hoses) are automatically injected into plans when not already covered by OEM schedule data. Uses standard intervals, respects shop exclusion overrides and shop interval overrides, matches against service history and deferred work. Source tagged as `"common"` in plan builder output.
*   **Maintenance & Service**: Intelligent queue-based prefetching for maintenance planning, component tracking, and logging declined services.
*   **Enterprise Capabilities**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution, enterprise-wide job search, and settings replication.
*   **Modular Features**: A la carte feature flags control functionalities like maintenance, job lookup, oil stickers, keytags, auto booking, and part cross-reference.

## External Dependencies
*   **Database**: MongoDB Atlas, PostgreSQL
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoFlow, AutoVitals, Tekmetric
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API