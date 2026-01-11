# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system provides auto shops with tools for managing vehicle maintenance recommendations and customer data. It offers AI-powered insights, multi-shop user management, and a comprehensive dashboard to enhance efficiency and customer satisfaction through integrations with industry-specific services. The project aims to be a comprehensive, AI-enhanced platform for automotive maintenance management, improving operational efficiency and customer engagement for auto shops.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application uses Next.js 14.2.5 with React 18, Next.js API Routes, MongoDB Atlas, and Tailwind CSS, built with TypeScript/JavaScript.

**UI/UX Decisions:**
The design features a modern SaaS-style interface with a dark sidebar, light content areas, card-based layouts, and blue as the accent color. Key UI elements include a unified integrations page, a tabbed vehicle detail page, visual data source badges, and a "My Oil Sticker" dashboard for QR code previews, customization, and downloads, alongside a "Quick Sticker" feature for rapid printing.

**Technical Implementations:**
*   **Data Management**: MongoDB Atlas for caching third-party API responses with TTLs and managing normalized data with provenance tracking.
*   **Integration Mechanisms**: Webhook integration for real-time updates, sync workers for shop management system data (e.g., Protractor, Tekmetric canned jobs), and an `ISMSAdapter` interface for SMS communication.
*   **Authentication & Authorization**: Role-based access with bcrypt hashing and token-based setup.
*   **Billing & Monitoring**: VIN-based billing, Stripe integration for subscriptions, admin audit logging, unified API usage monitoring with throttling and circuit breakers, and sync worker health monitoring.
*   **Sticker Generation**: Automatic QR provisioning via HoverCode, sticker image generation using `node-html-to-image`, and configurable sticker schemas with predictive date calculation. A Chrome Extension API fetches sticker configurations.
*   **Tekmetric Sync**: Automated initial sync, OAuth token management with auto-refresh, and an incremental sync system with per-shop state tracking and concurrent batch processing.
*   **Core Features**: AI-powered vehicle analysis, customer dashboard, multi-shop management, maintenance planning with intelligent prefetching, component tracking, declined services logging, enterprise features (multi-location analytics, shared jobs), and a platform admin panel.
*   **Chrome Extension**: MOS Tools Chrome Extension integrates with Tekmetric for maintenance recommendations, common failures advisor, job lookup, canned jobs, and oil change sticker printing.
*   **Job Management**: AI-scored job lookup with enterprise support and smart job autocomplete with historical data.
*   **Common Failures Advisor**: Predicts common repairs based on shop data and AI fallback.
*   **Auto Booking**: Infrastructure for automated appointment scheduling, including dynamic holiday system, scheduler, queue management, and integration with SMS systems via the `ISMSAdapter`. Features include:
    - **Daily Email Reminders**: Configurable scheduled reminders sent to shop staff about pending bookings. Shop owners can set reminder time (HH:MM), days of week to send (Mon-Sun), and whether to skip holidays.
    - **Queue Expiry**: Pending bookings automatically expire after a configurable number of days (1-90), removing stale entries from the review queue.
    - **Cron Endpoint**: `/api/cron/auto-booking-reminders` for external scheduler integration (requires CRON_SECRET env var).
    - **Booking Queue UI**: Sidebar link with pending count badge for quick access to bookings awaiting review.
*   **Manual Vehicle Management**: Standalone shops can manually add vehicles via VIN decode with strict validation (year 1900-current, mileage 0-2M). Admin-controlled `allowManualClose` preference enables close/archive functionality for both manual entries and integration vehicles. Closed VINs are filtered from dashboard.

## Planned Features
*   **Digital Wallet Pass**: Dynamic oil change reminder passes for Apple Wallet and Google Wallet. Replaces traditional windshield stickers with always-available phone reminders. Features include: remote updates when service date/mileage changes, push notifications when service is due, geo-fencing to show on lock screen near the shop, and "Book Now" integration with Auto Booking. Customer adds pass via QR scan or link after service. **Marketing tagline**: "Finally, an oil sticker that never falls off, never fades, never expires — and is smarter than ever."
*   **Key Tag Printing**: Printable key tags with customer name, vehicle info (Year/Make/Model), VIN, license plate, RO#, color. Data fields already exist in normalized schema (exteriorColor, licensePlate, licensePlateState).
*   **Customer Concern Tool**: Structured symptom-based intake system for capturing customer-reported vehicle issues. Features system-specific question flows (brakes, cooling, transmission, steering/suspension, A/C, emissions, etc.) that guide advisors through gathering detailed diagnostic information. Includes smart prompts like "Tell me the story about your [issue]" instead of assumptive questions. Captures warning light status, symptom duration, conditions when symptoms occur, and relevant history. Data feeds into vehicle records for technician review and AI-powered diagnostic suggestions.

## External Dependencies
*   **Database**: MongoDB Atlas
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management Systems**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API