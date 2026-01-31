# MOS Maintenance MVP

## Overview
This Next.js-based automotive maintenance management system streamlines operations for auto shops by providing tools for managing vehicle maintenance recommendations and customer data. It offers AI-powered insights, multi-shop user management, and a comprehensive dashboard to enhance efficiency and customer satisfaction through integrations with industry-specific services. The project's ambition is to provide a comprehensive, AI-enhanced platform for automotive maintenance management, improving operational efficiency and customer engagement for auto shops.

## User Preferences
I prefer simple language and clear explanations. I want iterative development, with frequent updates and opportunities for feedback. Ask before making major changes.

## System Architecture
The application uses Next.js 14.2.5 with React 18, Next.js API Routes, MongoDB Atlas, and Tailwind CSS, built with TypeScript/JavaScript.

**UI/UX Decisions:**
The design features a modern SaaS-style interface with a dark sidebar, light content areas, card-based layouts, and blue as the accent color. Key UI elements include a unified integrations page, a tabbed vehicle detail page, visual data source badges, and dedicated UIs for "My Oil Sticker" and "Quick Sticker" features with customization and rapid printing. Keytag printing includes a visual designer with drag-and-drop editing and live preview.

**Technical Implementations:**
*   **Data Management**: MongoDB Atlas is currently used for caching and state tracking, with a planned migration to PostgreSQL for core business data to leverage its relational capabilities for complex reporting and data integrity. Plan caching in `lib/plan-cache.ts` stores assembled plan buckets for instant loads with mileage tolerance-based invalidation.
*   **Integration Mechanisms**: A modular integration layer uses `IIntegrationAdapter` and `IntegrationFacade` for shop management systems (e.g., Tekmetric, Protractor), featuring webhooks, incremental sync, OAuth, and rate limiting. An `ISMSAdapter` interface normalizes SMS data.
*   **Authentication & Authorization**: Role-based access with bcrypt hashing and token-based setup.
*   **Billing & Licensing**: VIN-based billing with trial limits, Stripe integration, and feature flags for modular functionality.
*   **Admin & Monitoring**: Comprehensive admin audit logging, unified API usage monitoring, and a support ticketing system.
*   **Notification System**: Email notifications via Resend API and in-app notifications.
*   **AI Support Chatbot**: Floating chat widget with OpenAI-powered responses, knowledge base retrieval, and ticket escalation.
*   **Sticker & Keytag Generation**: QR code generation using HoverCode API, sticker image generation via `node-html-to-image`, and Dymo label printing with a visual designer.
*   **AI & Recommendations**: AI-powered maintenance recommendations, AI-scored job search, smart job autocomplete, and a common failures advisor.
*   **Auto Booking**: A feature-gated system for automated oil change appointment scheduling.
*   **Chrome Extension**: A side panel extension for Tekmetric integration, providing maintenance recommendations, job history, and sticker printing.

**Feature Specifications:**
*   **Core Management**: Vehicle analysis, customer dashboard, multi-shop management.
*   **Maintenance & Service**: Intelligent queue-based prefetching for maintenance planning, component tracking, and logging declined services.
*   **Enterprise Capabilities**: Multi-location analytics, shop management, shared canned job mappings, revenue attribution, enterprise-wide job search, and settings replication.
*   **Modular Features**: A la carte feature flags for various functionalities (e.g., maintenance, job lookup, oil sticker, keytags, auto booking, part cross-reference) managed via platform admin.
*   **User Preferences**: Shops can choose distance units (miles/kilometers).

## External Dependencies
*   **Database**: MongoDB Atlas (with a planned migration to PostgreSQL)
*   **AI**: OpenAI API
*   **Payments**: Stripe
*   **VIN Decoding & OEM Schedules**: DataOne API
*   **Shop Management & Repair Orders**: AutoFlow, Protractor, Tekmetric
*   **Vehicle History Reports**: CARFAX
*   **Digital Vehicle Inspections (DVI)**: AutoVitals
*   **QR Code Generation**: HoverCode API
*   **Email Notifications**: Resend API

---

## Future Work

### Robust Stripe Billing with Grace Periods
**Priority:** High | **Status:** Idea

### AI Auto-Populate for Repair Orders
**Priority:** Medium | **Status:** Idea

### CARFAX-Based Mileage Estimation
**Priority:** Medium | **Status:** Idea

### Service History Timeline
**Priority:** Medium | **Status:** Idea

### Cross-Shop Customer View
**Priority:** Medium | **Status:** Idea

### AI-Powered KPI Dashboard
**Priority:** Medium | **Status:** Idea

### Deferred Work vs CARFAX Comparison
**Priority:** Medium | **Status:** Idea

---

## MongoDB to PostgreSQL Migration Plan
**Priority:** High | **Status:** Planning

### Strategy: Lift and Shift, Then Normalize

**Phase 1: Lift and Shift (Raw Data)**
Move all data to PostgreSQL as-is using JSONB columns. No transformation during migration.

**Phase 2: Normalize Incrementally**
Add normalized columns alongside raw JSONB, backfill, update queries one at a time.

### Current MongoDB Collections

**Raw API Response Caches:**
| Collection | Source | Data |
|------------|--------|------|
| `tekmetric_work_orders` | Tekmetric API | Raw RO/job data |
| `tekmetric_vehicle_cache` | Tekmetric API | Raw vehicle data |
| `tekmetric_customer_cache` | Tekmetric API | Raw customer data |
| `protractor_work_orders` | Protractor API | Raw work order data |
| `protractor_ro_cache` | Protractor API | Raw RO cache |
| `dataone_cache` | DataOne API | VIN decode/maintenance |
| `events` | AutoFlow webhooks | Raw webhook payloads |
| `sms_historical_work_orders` | Backfill scripts | Historical RO data |

**Already Normalized:**
| Collection | Status |
|------------|--------|
| `customers` | Partially normalized |
| `vehicles` | Partially normalized |
| `repair_orders` | Partially normalized |
| `normalized_work_orders` | Fully normalized |

**Core Business (Migrate):**
- `shops`, `users`, `sessions`, `enterprise_accounts`
- `viewed_vins`, `job_index`, `shop_features`
- `notifications`, `support_chat_sessions`

**Keep in MongoDB (Cache Only):**
- `cached_plans`, `plan_prefetch_cache`
- All `*_cache` collections for API responses

### Phase 1 Schema (JSONB-First)

```sql
-- Raw data tables - preserve everything
CREATE TABLE raw_work_orders (
  id SERIAL PRIMARY KEY,
  shop_id VARCHAR(50) NOT NULL,
  source VARCHAR(20) NOT NULL,  -- 'tekmetric' | 'protractor' | 'autoflow'
  external_id VARCHAR(100),
  raw_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_id, source, external_id)
);

CREATE TABLE raw_vehicles (
  id SERIAL PRIMARY KEY,
  shop_id VARCHAR(50) NOT NULL,
  vin VARCHAR(17),
  source VARCHAR(20) NOT NULL,
  external_id VARCHAR(100),
  raw_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE raw_customers (
  id SERIAL PRIMARY KEY,
  shop_id VARCHAR(50) NOT NULL,
  source VARCHAR(20) NOT NULL,
  external_id VARCHAR(100),
  raw_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for querying JSONB
CREATE INDEX idx_raw_wo_shop ON raw_work_orders(shop_id);
CREATE INDEX idx_raw_wo_vin ON raw_work_orders((raw_data->>'vin'));
CREATE INDEX idx_raw_vehicles_vin ON raw_vehicles(vin);
```

### Phase 2 Schema (Add Normalized Columns)

```sql
-- Add normalized columns alongside raw_data
ALTER TABLE raw_vehicles ADD COLUMN year INTEGER;
ALTER TABLE raw_vehicles ADD COLUMN make VARCHAR(50);
ALTER TABLE raw_vehicles ADD COLUMN model VARCHAR(100);
ALTER TABLE raw_vehicles ADD COLUMN mileage INTEGER;

-- Backfill from JSONB (Tekmetric example)
UPDATE raw_vehicles SET
  year = (raw_data->>'year')::INTEGER,
  make = raw_data->>'make',
  model = raw_data->>'model',
  mileage = (raw_data->>'mileage')::INTEGER
WHERE source = 'tekmetric';

-- Add indexes on normalized columns
CREATE INDEX idx_vehicles_make_model ON raw_vehicles(make, model);
```

### Migration Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1. Lift & Shift | 2 weeks | All data in PostgreSQL JSONB |
| 2. Validation | 1 week | Row counts match, queries work |
| 3. Normalize vehicles | 1 week | VIN, year, make, model columns |
| 4. Normalize customers | 1 week | Phone, email, name columns |
| 5. Normalize ROs | 1 week | RO number, status, amounts |
| 6. Cutover reads | 1 week | PostgreSQL primary for reads |
| 7. Cutover writes | 1 week | MongoDB becomes cache-only |

### Rollback Plan
- MongoDB stays fully synced for 30 days
- Feature flag to switch back to MongoDB reads
- Documented rollback procedure