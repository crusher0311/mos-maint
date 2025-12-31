# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system aims to streamline operations for auto shops. It provides tools for managing vehicle maintenance recommendations and customer data, offering AI-powered insights, multi-shop user management, and a comprehensive dashboard. The system enhances shop efficiency and customer satisfaction through integrations with industry-specific services.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5 with React 18 for the frontend and Next.js API Routes for backend functionality. MongoDB Atlas is the cloud-hosted database, and styling is managed with Tailwind CSS. The project uses TypeScript/JavaScript.

**UI/UX Decisions:**
The application features a modern SaaS-style design with a dark sidebar, light content areas, card-based layouts, and blue as the accent color. Key UI components include `Sidebar`, `AppLayout`, `LoginForm`, and `DashboardClient`. It provides a unified integrations page, a tabbed vehicle detail page, and visual data source badges for recommendations.

**Technical Implementations:**
*   **Data Caching**: MongoDB Atlas is used for caching third-party API responses with defined TTLs.
*   **Webhook Integration**: Utilizes webhooks for real-time updates from integrations.
*   **CARFAX Mileage Interpolation**: A smart algorithm estimates mileage.
*   **Canned Jobs (Multi-SMS)**: Syncs canned jobs from Protractor and Tekmetric, with UI adapting to the configured SMS.
*   **Shop Maintenance Intervals**: Allows shops to define custom maintenance schedules.
*   **Data Model**: Supports `enterprise_accounts` with `shopIds` and `shops` having `enterpriseId`.
*   **Authentication & Authorization**: Role-based access (`owner`, `admin`, `manager`, `user`, `viewer`) with bcrypt password hashing and token-based setup.
*   **VIN-Based Billing**: Tracks "active" vehicles for billing with configurable trial limits and platform admin controls for VIN allowances.
*   **Stripe Billing Integration**: Handles checkout sessions for plan upgrades, webhook processing for subscriptions, and a billing portal.
*   **Distance Unit Preferences**: Shops can choose between miles or kilometers for mileage display.

**Feature Specifications:**
*   **Vehicle Analysis**: AI-powered maintenance recommendations based on vehicle history.
*   **Customer Dashboard**: Comprehensive tracking of customers and their vehicles.
*   **Multi-Shop Management**: User authentication with role-based access for multiple shops.
*   **Maintenance Planning**: Intelligent queue-based prefetching for vehicle data, configurable "Due Soon" thresholds, and display of OEM, shop, DVI, CARFAX, and Protractor recommendations.
*   **Component Tracking & Declined Services**: Advisors can track vehicle components and log declined services.
*   **Enterprise Features**: Multi-location analytics, shop management, shared canned job mappings, and revenue attribution tracking via webhooks.
*   **Platform Admin Panel**: Internal MOS staff panel for platform-wide statistics, shop management, user directory, and OpenAI API usage tracking.
*   **Modular Feature Architecture**: Supports à la carte feature toggles (`maintenance`, `job_lookup`, `oil_sticker`, `part_xref`) allowing shops to enable/disable specific tools.
*   **SMS Adapter Architecture**: An `ISMSAdapter` interface provides abstraction for shop management systems (currently Protractor, with future support for Tekmetric, AutoFlow).
*   **MOS Tools Chrome Extension**: A side panel MV3 extension for Tekmetric integration, providing maintenance plans, job history search, and push-to-RO functionality.

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe (subscriptions, billing portal)
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals (via Chrome Extension)
*   **MOS Tools Chrome Extension**: Custom Chrome extension for Tekmetric integration