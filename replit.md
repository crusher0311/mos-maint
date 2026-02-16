# MOS Maintenance MVP

## Overview
This project is an AI-enhanced automotive maintenance management system built with Next.js. Its primary purpose is to streamline operations for auto shops by providing tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. It features an intuitive dashboard and aims to improve operational efficiency and customer engagement through various integrations and AI-powered insights.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, with TypeScript/JavaScript. Data management is transitioning from MongoDB Atlas to PostgreSQL for core relational data, with MongoDB Atlas currently used for caching.

**UI/UX Decisions:**
The user interface features a modern SaaS design with a dark sidebar, light content areas, and card-based layouts, accented with blue. Key UI elements include a unified integrations page, tabbed vehicle detail pages, visual data source badges, and dedicated UIs for "My Oil Sticker" and "Quick Sticker" with customization and rapid printing. Keytag printing includes a visual designer with drag-and-drop editing and live preview. The Health Intelligence plan page displays OE manufacturer logos (locally hosted in `/public/logos/makes/`), dynamic Year/Make/Model titles, and "Vehicle Health Intelligence" branding with icon on the right side. VIN tooltips show service-relevant specs (front/rear tires, front/rear brakes, wheelbase).

**Technical Implementations:**
*   **Data Management**: Data is transitioning from MongoDB Atlas to PostgreSQL. Plan caching stores assembled plan buckets for instant loads with mileage tolerance-based invalidation.
*   **Integration Mechanisms**: A modular integration layer supports shop management systems (e.g., Tekmetric, Protractor) through `IIntegrationAdapter` and `IntegrationFacade` patterns, incorporating webhooks, incremental sync, OAuth, and rate limiting. An `ISMSAdapter` interface normalizes SMS data.
*   **Authentication & Authorization**: Role-based access using bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: VIN-based billing with trial limits, Stripe integration, modular feature flags, and robust grace period handling. Grace periods (7 days) automatically trigger on payment failure with email reminders at days 3-4 and 1-2 remaining. Accounts transition to suspended status when grace expires, with automatic feature disable. Admins can extend grace periods via `/api/admin/billing/extend-grace`. Daily cron job checks expired grace periods (`scripts/daily-grace-check.ts`).
*   **Admin & Monitoring**: Includes comprehensive admin audit logging, unified API usage monitoring, and a support ticketing system. Platform Observability page (`/dashboard/admin/observability`) provides streamed log viewing from Render deployments with filtering, and API usage analytics across all providers. Log stream ingestion via POST webhook at `/api/platform-admin/log-stream` with 30-day retention (TTL).
*   **Notification System**: Supports email notifications via Resend API and in-app notifications.
*   **AI Support Chatbot**: A floating chat widget provides OpenAI-powered responses, knowledge base retrieval, and ticket escalation.
*   **Sticker & Keytag Generation**: QR codes are generated using HoverCode API, sticker/keytag images rendered via `node-canvas` (lib/canvas-renderer.ts) for instant (<500ms) generation without Chromium dependency. Supports standard and designer layouts for both stickers and keytags. Dymo label printing is supported with a visual designer. Inter font files stored in assets/fonts/.
*   **AI & Recommendations**: Offers AI-powered maintenance recommendations, AI-scored job search, smart job autocomplete, and a common failures advisor.
*   **Auto Booking**: A feature-gated system for automated oil change appointment scheduling.
*   **Chrome Extension**: A side panel extension (v1.12.0) enhances Tekmetric integration with maintenance recommendations, job history, sticker printing, and automatic labor rate rules application with toast notifications. Includes CARFAX-based mileage estimation when odometer is zero (uses last 3 data points within 5 years to calculate miles/day rate, requires minimum 2 data points). Estimated mileage displays as bold italic with hover tooltip showing estimation details. Features per-sticker QR code toggle, predictive service date calculation using miles-per-day driving habits, power icon logout button with red hover, options page redirect to sticker settings, and AI support chat with ticket submission/escalation (via `/api/extension/support`). Feature-gated tabs are clickable even when locked, showing an upgrade overlay with lock icon and feature name instead of blocking access. Default tab selection picks the first subscribed feature.

**Feature Specifications:**
*   **Core Management**: Vehicle analysis, customer dashboards, and multi-shop management.
*   **Maintenance & Service**: Intelligent queue-based prefetching for maintenance planning, component tracking, and logging declined services. Extension-triggered background prefetch: when a Tekmetric extension user views a plan for one RO, other open ROs at the same shop are prefetched in the background (up to 15, rate-limited per shop with DB lock).
*   **Enterprise Capabilities**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution, enterprise-wide job search, and settings replication.
*   **Modular Features**: A la carte feature flags control functionalities like maintenance, job lookup, oil stickers, keytags, auto booking, and part cross-reference.
*   **User Preferences**: Shops can select their preferred distance units (miles/kilometers).

## External Dependencies
*   **Database**: MongoDB Atlas (planned migration to PostgreSQL), PostgreSQL
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne (local PostgreSQL, SFTP sync weekly)
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API

## Important Project Files
*   **FEATURE_BACKLOG.md**: Tracks all planned features and future work items. Always check this file for pending enhancements.
*   **MOS-REBUILD-PLAN.md**: Long-term architecture roadmap for ground-up rebuild.