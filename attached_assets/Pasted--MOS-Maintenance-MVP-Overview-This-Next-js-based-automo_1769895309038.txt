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

### Strategy: Raw Archive + Clean Normalized Tables

**Phase 1: Copy Raw Data**
Move all MongoDB data to PostgreSQL `raw_*` tables using JSONB. These become permanent archive/audit tables - never modified after initial load.

**Phase 2: Build New Normalized Tables**
Create clean, properly structured tables (`vehicles`, `customers`, `repair_orders`, etc.) with proper relationships and indexes.

**Phase 3: Populate from Raw**
Write transform scripts that read from `raw_*` JSONB and insert into normalized tables. One script per platform (Tekmetric, Protractor, AutoFlow).

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

### Phase 1: Raw Archive Tables

```sql
-- Permanent archive tables - never modified after migration
CREATE TABLE raw_work_orders (
  id SERIAL PRIMARY KEY,
  shop_id VARCHAR(50) NOT NULL,
  source VARCHAR(20) NOT NULL,  -- 'tekmetric' | 'protractor' | 'autoflow'
  external_id VARCHAR(100),
  raw_data JSONB NOT NULL,
  migrated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_id, source, external_id)
);

CREATE TABLE raw_vehicles (
  id SERIAL PRIMARY KEY,
  shop_id VARCHAR(50) NOT NULL,
  source VARCHAR(20) NOT NULL,
  external_id VARCHAR(100),
  raw_data JSONB NOT NULL,
  migrated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE raw_customers (
  id SERIAL PRIMARY KEY,
  shop_id VARCHAR(50) NOT NULL,
  source VARCHAR(20) NOT NULL,
  external_id VARCHAR(100),
  raw_data JSONB NOT NULL,
  migrated_at TIMESTAMP DEFAULT NOW()
);
```

### Phase 2: Clean Normalized Tables

```sql
-- Enterprise groupings
CREATE TABLE enterprises (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Shops with proper relationships
CREATE TABLE shops (
  id SERIAL PRIMARY KEY,
  shop_id VARCHAR(50) UNIQUE NOT NULL,  -- Legacy ID
  enterprise_id INTEGER REFERENCES enterprises(id),
  name VARCHAR(255) NOT NULL,
  integration_provider VARCHAR(20),  -- 'tekmetric' | 'protractor' | 'autoflow'
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Clean customer records
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id),
  enterprise_customer_id INTEGER,  -- Cross-shop linking
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(20),
  email VARCHAR(255),
  raw_id INTEGER REFERENCES raw_customers(id),  -- Link to source
  created_at TIMESTAMP DEFAULT NOW()
);

-- Clean vehicle records
CREATE TABLE vehicles (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id),
  customer_id INTEGER REFERENCES customers(id),
  vin VARCHAR(17) NOT NULL,
  year INTEGER,
  make VARCHAR(50),
  model VARCHAR(100),
  mileage INTEGER,
  mileage_updated_at TIMESTAMP,
  raw_id INTEGER REFERENCES raw_vehicles(id),  -- Link to source
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_id, vin)
);

-- Clean repair orders
CREATE TABLE repair_orders (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  customer_id INTEGER REFERENCES customers(id),
  ro_number VARCHAR(50),
  status VARCHAR(30),
  total_amount DECIMAL(10,2),
  closed_at TIMESTAMP,
  raw_id INTEGER REFERENCES raw_work_orders(id),  -- Link to source
  created_at TIMESTAMP DEFAULT NOW()
);

-- Separate line items table
CREATE TABLE ro_line_items (
  id SERIAL PRIMARY KEY,
  repair_order_id INTEGER REFERENCES repair_orders(id),
  service_key VARCHAR(50),
  description TEXT,
  labor_amount DECIMAL(10,2),
  parts_amount DECIMAL(10,2)
);

-- Deferred work with cross-shop support
CREATE TABLE deferred_work (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  service_key VARCHAR(50),
  description TEXT,
  estimated_amount DECIMAL(10,2),
  declined_at TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by_shop_id INTEGER REFERENCES shops(id),
  resolution VARCHAR(30)  -- 'completed' | 'done_elsewhere' | 'cancelled'
);

-- Indexes
CREATE INDEX idx_vehicles_vin ON vehicles(vin);
CREATE INDEX idx_vehicles_shop ON vehicles(shop_id);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_repair_orders_shop ON repair_orders(shop_id);
CREATE INDEX idx_deferred_shop ON deferred_work(shop_id);
```

### Phase 3: Transform Scripts

```
transform_tekmetric.ts   → Reads raw_*, writes to normalized tables
transform_protractor.ts  → Reads raw_*, writes to normalized tables  
transform_autoflow.ts    → Reads raw_*, writes to normalized tables
```

Each script handles platform-specific field mappings (e.g., Tekmetric's `firstName` vs Protractor's `FirstName`).

### Migration Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1. Copy Raw Data | 2 weeks | All MongoDB data in `raw_*` PostgreSQL tables |
| 2. Validate | 1 week | Row counts match, JSONB queryable |
| 3. Build Normalized Schema | 1 week | Create clean tables with relationships |
| 4. Transform Scripts | 2 weeks | Populate normalized tables from raw |
| 5. Cutover Reads | 1 week | App reads from PostgreSQL |
| 6. Cutover Writes | 1 week | New data goes to PostgreSQL |
| 7. MongoDB → Cache Only | 1 week | Remove MongoDB from critical path |

### Rollback Plan
- MongoDB stays fully synced for 30 days
- Feature flag to switch back to MongoDB reads
- `raw_*` tables preserved permanently as audit trail
- Documented rollback procedure