# MOS Maintenance MVP

## Overview
This project is a Next.js-based automotive maintenance management system designed to streamline operations for auto shops. It offers AI-powered insights, multi-shop user management, and a comprehensive dashboard. The system integrates with industry-specific services to enhance efficiency and customer satisfaction. The primary goal is to provide an AI-enhanced platform for automotive maintenance management, improving operational efficiency and customer engagement.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5 with React 18, Next.js API Routes, MongoDB Atlas, and Tailwind CSS, primarily in TypeScript/JavaScript.

**UI/UX Decisions:**
The design features a modern SaaS-style interface characterized by a dark sidebar, light content areas, card-based layouts, and blue as the accent color. Key UI elements include a unified integrations page, a tabbed vehicle detail page, visual data source badges for recommendations, and a "My Oil Sticker" dashboard with live QR code previews and customization options. A "Quick Sticker" feature allows rapid sticker printing with configurable units and service intervals, while keytag printing offers a visual designer with drag-and-drop editing and live preview. In-app guidance includes a Welcome modal for first-time users, Help Center page with searchable guides and FAQs, and reusable Tooltip components for contextual help.

**Technical Implementations:**
*   **Data Management**: MongoDB Atlas is used for caching API responses, state tracking, and normalized data storage.
*   **Integration Mechanisms**: Features include webhooks for real-time updates and an incremental synchronization system for shop management systems (e.g., Tekmetric, Protractor), incorporating robust error handling, OAuth token management, and rate limiting. A modular adapter architecture (`ISMSAdapter`) normalizes data layers across different shop management systems.
*   **Authentication & Authorization**: Role-based access control is implemented with bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: VIN-based billing with trial limits, Stripe integration for payment processing, and feature flags to manage modular functionality.
*   **Admin & Monitoring**: Comprehensive audit logging, unified API usage monitoring, Chrome Extension Version API, and a support ticketing system with email and in-app notifications.
*   **Notification System**: Email notifications are handled via Resend API, complemented by an in-app notification bell with real-time polling. System-wide announcements can be sent from Platform Admin to targeted users (all users, by shop, by role, or by SMS integration type like Tekmetric/Protractor/AutoFlow) with dual delivery via in-app notifications and email. Critical announcements display as banners on the dashboard.
*   **AI Support Chatbot**: A floating chat widget utilizes OpenAI for responses, retrieves information from a knowledge base of resolved tickets, and supports chat session persistence and ticket escalation.
*   **Sticker & Keytag Generation**: QR code generation uses the HoverCode API, sticker images are generated via Puppeteer browser pool (`lib/browser-pool.ts`) for fast rendering, and Dymo label printing is used for keytags with a visual designer. Browser pool reuses instances (max 3, recycled after 50 uses/5min).
*   **AI & Recommendations**: The system provides AI-powered maintenance recommendations, AI-scored job searches, smart job autocompletion, and a common failures advisor using shop data and AI.
*   **Auto Booking**: A feature-gated system enables automated oil change appointment scheduling, including lead time configuration, holiday/business hour management, and a review queue, triggered by sticker printing.
*   **Chrome Extension**: A side panel extension integrates with Tekmetric, offering maintenance recommendations, common failures, job history search, canned jobs, and oil change sticker printing.
*   **Enterprise Capabilities**: Supports multi-location analytics, shop management, shared canned job mappings, revenue attribution, enterprise-wide job search, and settings replication.
*   **Performance Optimizations**: Batch operations utility (`lib/batch-operations.ts`) for bulk upserts and parallel processing. NodeCache-based caching layer for OEM schedules (24hr TTL) and shop configs (5min TTL). Query monitoring tracks operations >500ms at `/api/admin/query-stats`. Tekmetric sync uses bulk operations instead of per-vehicle queries. Client-side SWR provider (`lib/swr-config.tsx`) with reusable hooks (`hooks/use-api.ts`) for data caching and deduplication. Lazy-loaded heavy components (QuickStickerModal, SupportChatWidget, JobLookup, CommonFailuresPanel) via next/dynamic for faster initial load. Gzip/brotli compression enabled via Next.js. Comprehensive database indexes (`lib/db-indexes.ts`) for common query patterns including job lookups, vehicle cache, work orders, repair patterns, rate limits, sticker prints, and auto-booking queue.

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API