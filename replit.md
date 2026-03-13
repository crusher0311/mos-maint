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
*   **Chrome Extension (Detect Dog)**: The side panel extension (`v1.22.1`) supports Tekmetric, Shop-Ware, and AutoFlow, providing maintenance recommendations, job history, sticker printing, labor rate rules, and CARFAX-based mileage estimation. It includes a customer concern assistant powered by AI for intake, follow-up questions, conversation review, and cleaned write-up output, directly integrated into SMS concern fields. The extension supports multi-shop environments by aggregating user's shop IDs and resolving shop context via query parameters.
*   **Work Order Creation**: A multi-step wizard for creating Protractor work orders from the dashboard, integrating the Customer Concern Assistant, AI-scored job search, and forms for new customer/vehicle creation with VIN/license plate photo recognition.
*   **User Preferences**: Shops can select preferred distance units (miles/kilometers).

**Feature Specifications:**
*   **Core Management**: Vehicle analysis, customer dashboards, and multi-shop management.
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