# MOS Maintenance MVP

## Overview
MOS Maintenance MVP is an AI-enhanced automotive maintenance management system built with Next.js. Its primary purpose is to optimize operations for auto shops by providing tools for managing vehicle maintenance recommendations, customer data, and multi-shop user management. The system aims to significantly boost operational efficiency and customer engagement through an intuitive dashboard, various integrations, and AI-powered insights, with a vision to become the leading platform for automotive service management.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5, React 18, Next.js API Routes, and Tailwind CSS, primarily with TypeScript. The architecture employs a dual-database strategy, utilizing Supabase PostgreSQL for core relational data, CRM, and communications, and MongoDB Atlas for caching and legacy features.

**UI/UX Decisions:**
The UI adopts a modern SaaS aesthetic, characterized by a dark sidebar, light content areas, and card-based layouts accented with blue. Key features include a unified integrations page, tabbed vehicle detail views, visual data source badges, and dedicated UIs for "My Oil Sticker" and "Quick Sticker" with customization and rapid printing. A visual designer with drag-and-drop functionality is provided for keytag printing. Vehicle Health Intelligence (VHI) pages display OEM logos and dynamic vehicle titles, and VIN tooltips offer service-relevant specifications.

**Technical Implementations:**
*   **Data Management**: Core CRM and communication data reside in Supabase PostgreSQL, accessed via Drizzle ORM and a repository pattern. OEM maintenance data is also stored here, updated weekly. MongoDB Atlas is used for caching.
*   **Integration Mechanisms**: A modular integration layer supports various shop management systems (e.g., Tekmetric, Protractor, Shop-Ware) using adapter and facade patterns, incorporating webhooks, incremental sync, and OAuth.
*   **Authentication & Authorization**: Role-based access is implemented with bcrypt hashing and token-based authentication.
*   **Billing & Licensing**: Stripe integration handles VIN-based billing, supports modular feature flags, and manages various plan tiers, including automatic CRM provisioning for new shops.
*   **Admin & Monitoring**: The system includes admin audit logging, unified API usage monitoring, a support ticketing system, and a platform observability page for logs and API analytics.
*   **Notification System**: Email notifications are handled via Resend API, complemented by in-app notifications.
*   **AI Support Chatbot**: An OpenAI-powered floating chat widget provides instant answers, knowledge base retrieval, and ticket escalation.
*   **Sticker & Keytag Generation**: QR codes are generated via HoverCode API, and stickers/keytags are rendered using `node-canvas` for efficient, dependency-free printing with Dymo label printer support.
*   **Chrome Extensions**: Two extensions enhance functionality: one for Shop-Ware for context detection and adding repair order items, and "Detect Dog" for Tekmetric, Shop-Ware, and AutoFlow, offering maintenance recommendations, job history, and an AI-powered customer concern assistant.
*   **AI & Recommendations**: The system provides AI-powered maintenance recommendations, job search, smart job autocomplete, and a common failures advisor.
*   **Work Order Creation**: A multi-step wizard facilitates creating Protractor work orders from the dashboard, integrating AI assistance and VIN/license plate recognition.
*   **Vehicle Health Report (VHR)**: A shareable, mobile-friendly customer-facing report page displays a health score, overdue items, a service timeline, and due-soon details. Share links are generated with signed, expiring tokens.
*   **VHI API Endpoints & On-Demand Analysis**: Both internal and external API endpoints provide Vehicle Health Indicator data, including a health score and bucketed maintenance items. On-demand analysis allows real-time VHI generation upon request.
*   **Partner API Keys**: Global API keys for integration partners facilitate shop resolution per-request and enable broader access.
*   **VHI Auto-Build & Rebuild**: VHI data is automatically built when work orders are created and rebuilt when they are closed, ensuring up-to-date maintenance recommendations.
*   **Swagger UI**: Interactive API documentation is available at `/docs` and `/api/docs/ui`.
*   **Common Maintenance Layer**: Industry-standard maintenance items are automatically integrated into plans when not covered by OEM data, respecting shop-specific overrides.
*   **Communications**: Twilio powers voice calling, SMS, voicemail recording, and caller ID lookup, with conversation tracking and data stored in PostgreSQL.
*   **Rescue Rover AI Voice Agent**: An AI-powered phone assistant handles inbound calls using Twilio media streams, Deepgram for STT/TTS, and OpenAI GPT-4o for conversational intelligence, including customer lookup, callback scheduling, and call transfer.

## External Dependencies
*   **Database**: MongoDB Atlas, PostgreSQL (Supabase)
*   **AI**: OpenAI API, Deepgram (STT Nova-2, TTS Aura)
*   **Payments**: Stripe
*   **Communications**: Twilio (Voice, SMS, Media Streams)
*   **VIN Decoding & OEM Schedules**: DataOne
*   **Shop Management Systems**: AutoFlow, Protractor, Tekmetric, Shop-Ware
*   **Vehicle History Reports**: CARFAX
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API