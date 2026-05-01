# MOS Maintenance MVP

## Overview
MOS Maintenance MVP is an AI-enhanced automotive maintenance management system designed to optimize operations for auto shops. It provides tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. The system aims to boost operational efficiency and customer engagement through an intuitive dashboard, various integrations, and AI-powered insights, positioning itself as a leading platform for automotive service management.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built with Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, primarily using TypeScript. It employs a dual-database strategy with Supabase PostgreSQL for core relational data (CRM, communications), and MongoDB Atlas for caching and legacy features.

**UI/UX Decisions:**
The UI features a modern SaaS aesthetic with a dark sidebar, light content areas, and card-based layouts. Key features include a unified integrations page, tabbed vehicle detail views, visual data source badges, dedicated UIs for "My Oil Sticker" and "Quick Sticker," and a drag-and-drop visual designer for keytag printing.

**Technical Implementations:**
*   **Data Management**: Core CRM and communication data reside in Supabase PostgreSQL via Drizzle ORM. MongoDB Atlas is used for caching. Normalized data is dual-written to both databases.
*   **Integration Mechanisms**: A modular integration layer supports various shop management systems using adapter and facade patterns, with Chrome extensions for enhanced functionality.
*   **Authentication & Authorization**: Role-based access is implemented with bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: Stripe integration handles VIN-based billing, supports modular feature flags, and manages plan tiers.
*   **Admin & Monitoring**: Includes admin audit logging, unified API usage monitoring, support ticketing, platform observability, and a Client Health Score dashboard.
*   **Notification System**: Email notifications are handled via Resend API, complemented by in-app notifications.
*   **AI Support Chatbot**: An OpenAI-powered floating chat widget provides instant answers and knowledge base retrieval, with per-shop rate limiting and token ceilings.
*   **Sticker & Keytag Generation**: QR codes are generated, and stickers/keytags are rendered using `node-canvas` for efficient printing.
*   **VHI Coach (DVI Overlay)**: A floating overlay panel in the Detect Dog extension that appears during Digital Vehicle Inspections, matching inspection tasks to canonical service keys and displaying maintenance data.
*   **Pre-fill DVI & Build RO from VHI**: One-click actions in the Detect Dog extension to auto-fill DVI inspection ratings and propose/create jobs in Tekmetric based on VHI maintenance data.
*   **Enhance Notes (AI Findings)**: An AI-powered feature in the Detect Dog extension that rewrites technician inspection findings into professional customer-facing language.
*   **AI & Recommendations**: Provides AI-powered maintenance recommendations, smart job autocomplete, and a common failures advisor.
*   **Estimate Assist & Audit**: A comprehensive system including a Job Knowledge Base, Smart Job Builder API, AI Estimate Language API, and an Estimate Audit Engine.
*   **Work Order Creation**: A multi-step wizard for creating Protractor work orders, integrating AI assistance and VIN/license plate recognition.
*   **Vehicle Health Report (VHR)**: A shareable, mobile-friendly customer-facing report displaying health scores and service timelines.
*   **VHI API Endpoints & On-Demand Analysis**: Provides Vehicle Health Indicator data and real-time VHI generation.
*   **Common Maintenance Layer**: Industry-standard maintenance items are integrated into plans, respecting shop-specific overrides.
*   **Service Key Matching**: A shared module for normalizing free-text service job names to canonical service keys.
*   **Communications**: Twilio powers voice calling, SMS, voicemail recording, and caller ID lookup with conversation tracking.
*   **Rescue Rover AI Voice Agent**: An AI-powered SaaS client support phone assistant using Twilio, Deepgram, and OpenAI GPT-4o.
*   **Call Center Management**: Features include phone number management, agent groups, time tracking, a call activity dashboard, and canned message templates.
*   **CRM Account Hierarchy**: A multi-tier CRM account hierarchy supporting Agencies, Parent Organizations, Accounts, and Locations with configurable RBAC and branding overrides.
*   **CRM Contact Management**: A full contact management system for business contacts across the account hierarchy.
*   **CRM Sales Pipeline & Marketing Engine**: Includes a Kanban-style deal board, configurable funnel stages, campaigns, coupons, specials, message templates, and pricing administration.
*   **CRM Onboarding & Content System**: Provides a Trello-style onboarding board, tours, guides, banners, and content assignment.
*   **Tekmetric Webhook Integration**: Robust webhook integration for Tekmetric events, including safety nets, HMAC verification, and auto-subscription.
*   **Job Search Triple-Source**: Job search queries legacy MongoDB, normalized MongoDB, and Supabase PostgreSQL in parallel, with results deduplicated and scored.
*   **In-Process Cron Scheduler**: A `node-cron` based scheduler runs inside the main web service, utilizing a Mongo-backed distributed lock for concurrency safety.
*   **Tekmetric Migration Wizard**: A platform-admin tool within the Detect Dog Chrome extension for migrating Tekmetric open jobs, preserving data integrity and providing detailed audit logs.
*   **CRM Subsystem Feature Flag**: The entire CRM subsystem (including Onboarding, Sales Pipeline, Marketing, and Pricing) is controlled by a `CRM_ENABLED` environment variable, allowing for soft-hiding UI and API routes without code removal.

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
*   **Logging**: Better Stack