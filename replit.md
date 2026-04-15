# MOS Maintenance MVP

## Overview
MOS Maintenance MVP is an AI-enhanced automotive maintenance management system designed to optimize operations for auto shops. It provides tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. The system aims to boost operational efficiency and customer engagement through an intuitive dashboard, various integrations, and AI-powered insights, positioning itself as a leading platform for automotive service management.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built with Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, primarily using TypeScript. It employs a dual-database strategy with Supabase PostgreSQL for core relational data, CRM, and communications, and MongoDB Atlas for caching and legacy features.

**UI/UX Decisions:**
The UI features a modern SaaS aesthetic with a dark sidebar, light content areas, and card-based layouts. It includes a unified integrations page, tabbed vehicle detail views, visual data source badges, and dedicated UIs for "My Oil Sticker" and "Quick Sticker." A visual designer with drag-and-drop functionality is provided for keytag printing. Vehicle Health Intelligence (VHI) pages display OEM logos and dynamic vehicle titles.

**Technical Implementations:**
*   **Data Management**: Core CRM and communication data reside in Supabase PostgreSQL via Drizzle ORM. MongoDB Atlas is used for caching.
*   **Integration Mechanisms**: A modular integration layer supports various shop management systems (e.g., Tekmetric, Protractor, Shop-Ware) using adapter and facade patterns. Tekmetric inspection data is fetched via an internal API.
*   **Authentication & Authorization**: Role-based access is implemented with bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: Stripe integration handles VIN-based billing, supports modular feature flags, and manages plan tiers.
*   **Admin & Monitoring**: Includes admin audit logging, unified API usage monitoring, a support ticketing system, a platform observability page, and a Client Health Score dashboard.
*   **Notification System**: Email notifications are handled via Resend API, complemented by in-app notifications.
*   **AI Support Chatbot**: An OpenAI-powered floating chat widget provides instant answers and knowledge base retrieval.
*   **Sticker & Keytag Generation**: QR codes are generated via HoverCode API, and stickers/keytags are rendered using `node-canvas` for efficient printing.
*   **Chrome Extensions**: Extensions enhance functionality for Shop-Ware, AutoFlow, and "Detect Dog," providing context detection, repair order item management, and maintenance recommendations.
*   **API Sniffer (Dev Tools)**: A platform-admin-only feature in the Detect Dog extension for capturing and analyzing API traffic from integrated systems. Captures are uploaded to a server-side endpoint (`sniffer_sessions` table in Supabase) for storage and analysis.
*   **VHI Coach (DVI Overlay)**: A floating overlay panel in the Detect Dog extension that appears during Digital Vehicle Inspections on Tekmetric. It matches shop-specific inspection task names to canonical service keys via `lib/service-keys.ts`, cross-references with VHI maintenance data, and shows techs which items are overdue, due soon, or OK. API: `/api/extension/vhi-coach`. Extension files: `vhi-coach.js` (content script overlay), `background.js` (coach data fetch).
*   **AI & Recommendations**: Provides AI-powered maintenance recommendations, smart job autocomplete, and a common failures advisor.
*   **Estimate Assist & Audit**: A comprehensive system including a Job Knowledge Base, Smart Job Builder API, AI Estimate Language API (technical to customer-facing), and an Estimate Audit Engine with rule-based and AI analysis.
*   **Work Order Creation**: A multi-step wizard for creating Protractor work orders, integrating AI assistance and VIN/license plate recognition.
*   **Vehicle Health Report (VHR)**: A shareable, mobile-friendly customer-facing report displaying health scores and service timelines.
*   **VHI API Endpoints & On-Demand Analysis**: Provides Vehicle Health Indicator data and real-time VHI generation.
*   **Partner API Keys**: Global API keys facilitate shop resolution and broader integration partner access.
*   **VHI Auto-Build & Rebuild**: VHI data is automatically built and rebuilt upon work order creation and closure.
*   **Swagger UI**: Interactive API documentation is available at `/docs` and `/api/docs/ui`.
*   **Common Maintenance Layer**: Industry-standard maintenance items are integrated into plans, respecting shop-specific overrides.
*   **Service Key Matching**: A shared module for normalizing free-text service job names to canonical service keys.
*   **VHI Plan Diagnostics**: A platform-admin-only endpoint for debugging VHI issues per vehicle.
*   **Interval Apply Mode**: Custom intervals apply to all vehicles by default, with an option for "shop_only" application.
*   **Communications**: Twilio powers voice calling, SMS, voicemail recording, and caller ID lookup with conversation tracking.
*   **Rescue Rover AI Voice Agent**: An AI-powered SaaS client support phone assistant using Twilio, Deepgram for STT/TTS, and OpenAI GPT-4o for conversational intelligence.
*   **Call Center Management**: Features include phone number management, agent groups, time tracking, a call activity dashboard, and canned message templates.
*   **CRM Account Hierarchy**: A multi-tier CRM account hierarchy supporting Agencies, Parent Organizations, Accounts, and Locations with configurable RBAC and branding overrides.
*   **CRM Contact Management**: A full contact management system for business contacts across the account hierarchy.
*   **CRM Sales Pipeline & Marketing Engine**: Includes a Kanban-style deal board, configurable funnel stages, campaigns, coupons, specials, message templates, and pricing administration.
*   **CRM Onboarding & Content System**: Provides a Trello-style onboarding board, tours, guides, banners, and content assignment.
*   **Normalized Data Schema**: Six Drizzle ORM tables in Supabase PostgreSQL mirror core normalized MongoDB collections for vehicles, customers, work orders, service jobs, line items, and payments.
*   **Normalized Data Dual-Write to Supabase**: Core normalized entity types are dual-written to both MongoDB and Supabase/PostgreSQL.
*   **Job Search Triple-Source**: Job search queries three sources in parallel: legacy MongoDB, normalized MongoDB, and Supabase PostgreSQL, with results deduplicated and scored using DataOne-powered vehicle specs.
*   **Support Tickets Dual-Write**: Support tickets are dual-written to MongoDB and Supabase PostgreSQL.
*   **Production Log Caching**: Production logs from Better Stack are synced to a Supabase table with 30-day retention for fast, filterable access.

## External Dependencies
*   **Database**: MongoDB Atlas, PostgreSQL (Supabase)
*   **AI**: OpenAI API, Deepgram
*   **Payments**: Stripe
*   **Communications**: Twilio
*   **VIN Decoding & OEM Schedules**: DataOne
*   **Shop Management Systems**: AutoFlow, Protractor, Tekmetric, Shop-Ware
*   **Vehicle History Reports**: CARFAX
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API