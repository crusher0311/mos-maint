# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system aims to streamline operations for auto shops. It provides tools for managing vehicle maintenance recommendations, customer data, and integrates with various third-party services such as AutoFlow, CARFAX, DataOne, Protractor, and AutoVitals. The system offers AI-powered insights, multi-shop user management, and a comprehensive dashboard for tracking customers and vehicles, ultimately enhancing shop efficiency and customer satisfaction.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application is built using Next.js 14.2.5 with React 18 for the frontend, leveraging Next.js API Routes for backend functionality. MongoDB Atlas serves as the cloud-hosted database, and styling is managed with Tailwind CSS. The project uses TypeScript/JavaScript.

**Key Features:**
-   **Vehicle Analysis**: AI-powered maintenance recommendations based on vehicle history.
-   **Customer Dashboard**: Comprehensive tracking of customers and their vehicles.
-   **Multi-Shop Management**: User authentication with role-based access for multiple shops.
-   **Maintenance Planning**: Intelligent queue-based prefetching for vehicle data, configurable "Due Soon" thresholds, and display of OEM, shop, DVI, CARFAX, and Protractor recommendations.
-   **Component Tracking & Declined Services**: Advisors can track vehicle components and log declined services, which are then flagged on future recommendations.

**UI/UX Decisions:**
The application features a modern SaaS-style design.
-   **Navigation**: Dark sidebar (slate-900) with expandable sections and a quick access "Open Plan" button.
-   **Content Areas**: Light backgrounds (gray-50/white) with card-based layouts.
-   **Accent Color**: Blue (#3B82F6 / blue-600) for primary actions and highlights.
-   **Components**: Key components include a `Sidebar`, `AppLayout`, `LoginForm`, and `DashboardClient`.
-   **Unified Integrations Page**: Settings > Integrations provides a single tabbed interface for CARFAX, AutoFlow, Protractor, and AutoVitals configuration. Canned Job Mappings are accessible from the Protractor tab.
-   **Vehicle Detail Page**: Tabbed interface for Attributes, Recommendations (Recs), and History.
-   **Data Source Badges**: Visual indicators (OEM, DVI, CARFAX, Shop, Protractor) on recommendations.
-   **Loading Indicators**: `loading.tsx` for Plan and Vehicle Detail pages to show progress during API calls.

**Technical Implementations:**
-   **Data Caching**: Extensive use of MongoDB Atlas for caching third-party API responses (DataOne, Protractor, AutoVitals, CARFAX) with defined TTLs to improve performance.
-   **Webhook Integration**: Utilizes webhooks for real-time updates from integrations like Protractor.
-   **CARFAX Mileage Interpolation**: Smart algorithm for estimating mileage in CARFAX service records.
-   **Protractor Canned Jobs**: Syncs, allows manual entry, and provides mapping UI for canned jobs, enabling advisors to easily add them to repair orders. Service packages are inserted via TimeClock API using proper line type mapping (LaborLine, PartLine, SubletLine, OtherLine). Requires `UpdateWorkOrderPackage` and `UpdateWorkOrderLine` parameters set to "Yes" in Protractor Integration settings.
-   **Shop Maintenance Intervals**: Allows shops to define custom maintenance schedules that override OEM recommendations.
-   **Environment Configuration**: Configured for Replit with specific port settings and allowed origins.

## External Dependencies
-   **Database**: MongoDB Atlas
-   **AI**: OpenAI API (for AI-powered maintenance recommendations)
-   **VIN Decoding & OEM Schedules**: DataOne API
-   **Shop Management & Repair Orders**: AutoFlow, Protractor
-   **Vehicle History Reports**: CARFAX
-   **Digital Vehicle Inspections (DVI)**: AutoVitals