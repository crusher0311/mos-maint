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
*   **Integration Mechanisms**: Webhooks for real-time updates and an incremental sync system for shop management systems (e.g., Tekmetric, Protractor) with robust error handling, OAuth token management, and rate limiting. The integration layer is modular, enabling independent development of each integration with a unified `IIntegrationAdapter` interface and an `IntegrationFacade`.
*   **Authentication & Authorization**: Role-based access with bcrypt hashing and token-based setup.
*   **Billing & Licensing**: VIN-based billing with trial limits, Stripe integration for checkout and billing portal, and feature flags for modular functionality.
*   **Admin & Monitoring**: Comprehensive admin audit logging, unified API usage monitoring, Chrome Extension Version API, and a support ticketing system.
*   **Notification System**: Email notifications via Resend API and in-app notification bell.
*   **AI Support Chatbot**: Floating chat widget with OpenAI-powered responses, knowledge base retrieval, and ticket escalation.
*   **Sticker & Keytag Generation**: QR code generation using HoverCode API, sticker image generation via `node-html-to-image`, and Dymo label printing with a visual designer.
*   **AI & Recommendations**: AI-powered maintenance recommendations, AI-scored job search, smart job autocomplete, and a common failures advisor.
*   **SMS Adapter Architecture**: `ISMSAdapter` interface for shop management systems, enabling a normalized, SMS-agnostic data layer.
*   **Auto Booking**: A feature-gated system for automated oil change appointment scheduling.
*   **Chrome Extension**: A side panel extension integrating with Tekmetric for maintenance recommendations, job history, and sticker printing.
*   **Plan Caching**: Full plan caching in `lib/plan-cache.ts` stores assembled plan buckets (overdue, dueSoon, upcoming) for instant loads, with mileage tolerance-based invalidation.

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