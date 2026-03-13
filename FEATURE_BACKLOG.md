# Feature Backlog

This document tracks planned features and enhancements for MOS Maintenance MVP.

---

## 1. Robust Stripe Billing with Grace Periods

**Priority:** High  
**Status:** ✅ Complete (January 2026)

### Overview
Make the Stripe billing integration more robust with automatic feature control, grace periods, and account status management.

### Requirements

#### 1.1 Grace Period System
- **Duration:** 7 days from first failed payment
- Track `gracePeriodStartedAt` and `gracePeriodEndsAt` timestamps on shop billing record
- Platform admin can manually extend grace period for individual shops

#### 1.2 Billing Status States
| Status | Description | User Experience |
|--------|-------------|-----------------|
| `active` | Subscription current | Full access to all features |
| `past_due` | Payment failed, in grace period | Warning banner, full access |
| `suspended` | Grace period expired | Read-only access, features auto-disabled |
| `canceled` | Subscription canceled | Limited/trial access |

#### 1.3 Automatic Feature Control
- When status becomes `suspended`:
  - Auto-disable all features (maintenance, job_lookup, common_failures, oil_sticker, keytags, auto_booking, part_xref)
  - Show "Account Suspended" banner with link to update payment
- When payment resolves:
  - Auto-re-enable features based on their plan tier
  - Send "Welcome back" confirmation email

#### 1.4 Email Notifications
- **Payment Failed:** Immediate email with link to update payment method
- **Grace Period Halfway (Day 3-4):** Reminder email
- **2 Days Before Grace Expires:** Urgent warning email
- **Account Suspended:** Features disabled notification
- **Payment Recovered:** Confirmation email

#### 1.5 UI Updates
- Dashboard banner showing billing status when not "active"
- Billing settings page shows:
  - Current status
  - Grace period countdown (if applicable)
  - Link to Stripe portal to update payment
- Read-only mode UI for suspended accounts

#### 1.6 Platform Admin Controls
- View all shops with billing issues (past_due, suspended)
- Manually extend grace period for specific shops
- Override billing status if needed
- View payment failure history

#### 1.7 Background Job
- Daily cron/scheduled task to check for expired grace periods
- Auto-transition `past_due` → `suspended` when grace period ends
- Log all automatic status transitions

### Technical Implementation Notes
- Enhance `stripe/webhook/route.ts` to handle grace period logic
- Add new fields to shop billing record:
  - `gracePeriodStartedAt: Date | null`
  - `gracePeriodEndsAt: Date | null`
  - `gracePeriodExtendedBy: string | null` (admin email)
  - `gracePeriodExtendedAt: Date | null`
- Create background job for daily grace period checks
- Update feature resolver to check billing status before enabling features

---

## 2. AI Auto-Populate for Repair Orders

**Priority:** Medium  
**Status:** Idea

### Overview
An AI automation bot that analyzes vehicle context and automatically populates repair orders with relevant services.

### Data Sources
- Maintenance plan (overdue, due soon, upcoming)
- Deferred work (previously declined services)
- Common failures for year/make/model/mileage
- Shop's canned jobs

### Shop Preference Modes
| Mode | Description |
|------|-------------|
| `off` | Feature disabled |
| `suggest` | Shows recommendations, requires manual approval |
| `auto` | Automatically adds to every new RO (like auto booking) |

### Configuration Options
- Maximum items to auto-add
- Priority/confidence threshold
- Categories to include/exclude
- Manager approval for items over $X

### Implementation
1. Trigger on new RO creation
2. Gather all data sources for the vehicle
3. Send to OpenAI for analysis and ranking
4. Based on mode: show suggestions or auto-add items
5. Log all AI-added items for tracking

### Feature Flag
Add `auto_populate` to existing feature flags system

---

## 3. CARFAX-Based Mileage Estimation

**Priority:** Medium  
**Status:** ✅ Complete (February 2026)

### Overview
Use CARFAX history to estimate current mileage for vehicles without an input odometer reading, enabling plan generation.

### Algorithm
1. Fetch last 3 CARFAX data points with mileage readings
2. Calculate average miles per day between readings
3. Days since last reading = today - last CARFAX date
4. Estimated mileage = last reading + (avg miles/day × days since)

### UI/UX
- Display as "Estimated: ~70,000 mi" with distinct badge/color
- Allow user to override with actual reading at any time
- Show confidence level based on consistency of driving patterns

### Data Storage
- Store both `estimatedMileage` and `confirmedMileage`
- Track estimation date and source data points
- Invalidate estimate when real mileage is entered

### Use Cases
- Plan generation when `inputMileage` is null/0
- Prefetch and cache plans for vehicles without odometer readings
- More accurate "overdue" notifications

---

## 4. Service History Timeline

**Priority:** Medium  
**Status:** Idea

### Overview
A visual timeline showing the complete service history of a vehicle, combining data from multiple sources into one unified view.

### Data Sources (in priority order)
1. **Shop RO History** - Work performed at this shop (Tekmetric/Protractor/AutoFlow)
2. **CARFAX Service History** - Work performed at other shops
3. **Deferred Work** - Declined services (shown as yellow/warning items)
4. **OEM Milestones** - Factory-scheduled service intervals (shown as reference markers)

### Timeline Entry Types
| Type | Color | Description |
|------|-------|-------------|
| `completed` | Green | Service performed at this shop |
| `external` | Blue | Service performed elsewhere (CARFAX) |
| `declined` | Yellow | Customer declined, still pending |
| `milestone` | Gray | OEM recommended interval passed |

### UI/UX Design
- Vertical scrolling timeline, newest at top
- Each entry shows: date, mileage, service description, source badge
- Expandable details for full RO/CARFAX record
- Filter by service category (oil, brakes, tires, etc.)
- "Print" or "Share" button for customer-facing PDF/link

### Timeline Entry Schema
```typescript
{
  date: Date,
  mileage: number | null,
  serviceKey: string,        // normalized service category
  description: string,       // display text
  source: 'shop' | 'carfax' | 'deferred' | 'oem',
  sourceRef: string,         // RO number, CARFAX record ID, etc.
  status: 'completed' | 'external' | 'declined' | 'milestone'
}
```

### Key Features
- **Gap Detection** - Highlight periods with no service activity
- **Pattern Recognition** - "This vehicle typically gets oil changes every 4 months"
- **Service Consistency** - Show if customer is loyal vs. shopping around
- **Upcoming Preview** - Project future milestones based on driving patterns

### Customer-Facing Version
- Simplified view without pricing or internal notes
- Shareable link with expiration
- QR code on oil sticker links to timeline
- Builds trust and transparency

### Implementation Phases
1. Phase 1: Shop RO history only (quick win)
2. Phase 2: Add CARFAX integration
3. Phase 3: Add deferred work overlay
4. Phase 4: Customer sharing + QR integration

---

## 5. Cross-Shop Customer View

**Priority:** Medium  
**Status:** Idea

### Overview
For enterprise accounts with multiple locations, show unified customer view across all shops including all their vehicles and service history.

---

## 6. AI-Powered KPI Dashboard

**Priority:** Medium  
**Status:** Idea

### Overview
Dashboard with AI-analyzed key performance indicators including revenue trends, service patterns, and customer retention insights.

---

## 7. Deferred Work vs CARFAX Comparison

**Priority:** Medium  
**Status:** Idea

### Overview
Cross-reference deferred work against CARFAX service history to detect if declined services were completed elsewhere.

### Detection Logic
1. Track deferred work with timestamps and service categories
2. On CARFAX pull, scan for new service records after the decline date
3. Match service categories (e.g., "Brake Pads" declined → "Brake Service" in CARFAX)
4. Flag potential matches for advisor review

### UI - Deferred Work List
- Badge: "CARFAX activity detected" next to matched items
- Expandable detail showing CARFAX record date and description
- Days between decline and CARFAX service

### Advisor Actions
| Action | Description |
|--------|-------------|
| Mark as Done Elsewhere | Closes deferred item, logs reason |
| Still Needs Service | Keeps open (CARFAX was unrelated/partial) |
| Discuss with Customer | Flags for follow-up conversation |

### Benefits
- Creates natural conversation opportunities with customers
- Keeps deferred list accurate (advisor-controlled cleanup)
- Tracks "declined but done elsewhere" patterns
- Avoids re-recommending services already completed

### Data to Track
- Match confidence (exact vs category match)
- Days between decline and external service
- Advisor resolution (done elsewhere / still needed / discussed)

---

## 8. DataOne Direct Integration

**Priority:** High  
**Status:** ✅ Complete

### Overview
Replace external DataOne API server (EC2) with direct SFTP → PostgreSQL integration.

### Current State
- External API at `3.144.191.161:3000`
- Weekly SFTP updates (full files, not deltas)
- App calls API for VIN decoding and maintenance schedules
- MongoDB caches API responses

### Target State
- DataOne data loaded directly into PostgreSQL
- Local queries (~5ms) instead of API calls (~100-500ms)
- Weekly SFTP sync with atomic table swap (zero downtime)
- No external API dependency

### Performance Improvement
~10-100x faster: 5ms local vs 100-500ms API

### Estimated Duration
3-4 days

### SFTP Connection Details
- **Host:** sftp://sftp.dataonesoftware.com
- **Port:** 2222
- **Update Frequency:** Complete replacement file daily by 6am EST
- **Protocol:** SFTP only (not FTP or port 22)

**DataOne IPs (whitelist for firewall):**
- 52.41.161.7 (Primary)
- 35.164.72.128 (Secondary)
- 34.194.121.217 (Secondary)
- 34.227.238.224 (Secondary)

**Files Provided:**
- CSV data files
- SQL CREATE TABLE statements

### Key DataOne Tables (from SFTP)

**VIN_REFERENCE** - Primary VIN decoding table
| Field | Type | Description |
|-------|------|-------------|
| vin_id | int | Primary key |
| vehicle_id | int | Links to VEH_TRIM_STYLES |
| vin_pattern | varchar(10) | VIN positions 1-8,10,11 |
| year | int | Model year |
| make | varchar(24) | Make |
| model | varchar(32) | Model |
| trim | varchar(48) | Trim |
| style | varchar(128) | Style |
| drive_type | varchar(3) | FWD, RWD, AWD, 4X4, 4X2, 4WD |
| vehicle_type | varchar(24) | Car, SUV, Truck, Van |
| body_type | varchar(32) | Body type |
| engine_name | varchar(128) | Engine name |
| engine_size | float | Displacement in liters |
| engine_cylinders | int | Cylinder count |
| fuel_type | varchar(12) | Fuel type |
| trans_name | varchar(64) | Transmission name |
| trans_type | varchar(3) | A, M, CVT |
| wheelbase | float | Wheelbase in inches |
| brake_system | varchar(18) | Brake type |

**VEH_TRIM_STYLES** - Vehicle style details
| Field | Type | Description |
|-------|------|-------------|
| vehicle_id | int | Primary key |
| year | int | Model year |
| make | varchar(24) | Make |
| model | varchar(32) | Model |
| trim | varchar(48) | Trim |
| drive_type | varchar(10) | Drive type |
| style | varchar(128) | Style name |
| vehicle_type | varchar(24) | Car, SUV, Truck, Van |
| body_type | varchar(32) | Body type |
| doors | int | Door count |

**LKP_VEH_MODEL_NUMBER** - Model number lookup
| Field | Type | Description |
|-------|------|-------------|
| veh_mfr_model_num_id | int | Primary key |
| vehicle_id | int | Links to VEH_TRIM_STYLES |
| mfr_model_num | varchar(32) | Manufacturer model number |

**DEF_SPECIFICATION** - Specification definitions
| Field | Type | Description |
|-------|------|-------------|
| specification_id | int | Primary key |
| specification_category | varchar(32) | Category grouping |
| specification_name | varchar(32) | Name (e.g., Length, Curb Weight) |
| specification_value | varchar(32) | Value |

**LKP_VEH_STANDARD_SPECIFICATION** - Vehicle-to-spec lookup
| Field | Type | Description |
|-------|------|-------------|
| veh_specification_id | int | Primary key |
| vehicle_id | int | Links to VEH_TRIM_STYLES |
| specification_id | int | Links to DEF_SPECIFICATION |

**Key Specification Categories:**
- **Brakes:** Front/Rear Brake Diameter
- **Wheels and Tires:** Front/Rear Tire Description, Wheel Diameter, Wheel Size
- **Exterior Dimensions:** Length, Width, Height, Wheelbase, Ground Clearance
- **Weights and Capacities:** Curb Weight, Fuel Tank Capacity, Max Towing Capacity
- **Seating:** Max Seating, Head/Hip/Leg Room by row

### OEM Service Schedule Tables

**DEF_MAINTENANCE** - Service definitions
| Field | Type | Description |
|-------|------|-------------|
| maintenance_id | int | Primary key |
| maintenance_category | varchar(128) | Engine, Exhaust System, Coolant System, etc. |
| maintenance_name | text | Service description |
| maintenance_notes | text | Additional info |

**DEF_MAINTENANCE_INTERVAL** - Service intervals
| Field | Type | Description |
|-------|------|-------------|
| maintenance_interval_id | int | Primary key |
| interval_type | varchar(32) | "At" or "Every" |
| value | float | Numeric value |
| units | varchar(32) | Miles, Months, Hours |
| initial_value | float | Initial interval if different |

**DEF_MAINTENANCE_SCHEDULE** - OEM maintenance patterns
| Field | Type | Description |
|-------|------|-------------|
| maintenance_schedule_id | int | Primary key |
| schedule_name | varchar(255) | e.g., "Premium Maintenance" |
| schedule_description | text | Description |

**DEF_MAINTENANCE_OPERATING_PARAMETER** - Special conditions
| Field | Type | Description |
|-------|------|-------------|
| maintenance_operating_parameter_id | int | Primary key |
| operating_parameter | text | e.g., "Dusty driving conditions" |
| operating_parameter_notes | text | Notes |

**LKP_VIN_MAINTENANCE** - VIN-to-maintenance lookup (primary)
| Field | Type | Description |
|-------|------|-------------|
| vin_maintenance_id | int | Primary key |
| squish | varchar(16) | VIN pattern (positions 1-8,10,11) |
| trans_notes | varchar(255) | Transmission-specific notes |
| maintenance_schedule_id | int | Links to DEF_MAINTENANCE_SCHEDULE |
| maintenance_id | int | Links to DEF_MAINTENANCE |

**LKP_VIN_MAINTENANCE_INTERVAL** - VIN maintenance intervals
| Field | Type | Description |
|-------|------|-------------|
| vin_maintenance_interval_id | int | Primary key |
| vin_maintenance_id | int | Links to LKP_VIN_MAINTENANCE |
| maintenance_interval_id | int | Links to DEF_MAINTENANCE_INTERVAL |
| maintenance_operating_parameter_id | int | Links to operating conditions |

**LKP_YMM_MAINTENANCE** - Year/Make/Model fallback lookup
| Field | Type | Description |
|-------|------|-------------|
| ymm_maintenance_id | int | Primary key |
| year | smallint | Model year |
| make | varchar(24) | Make |
| model | varchar(32) | Model |
| eng_notes | varchar(128) | Engine-specific notes |
| maintenance_id | int | Links to DEF_MAINTENANCE |

---

## 9. MongoDB to PostgreSQL Migration

**Priority:** High  
**Status:** Planning

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

Each script handles platform-specific field mappings:
- `transform_tekmetric.ts` → Reads raw_*, writes to normalized tables
- `transform_protractor.ts` → Reads raw_*, writes to normalized tables
- `transform_autoflow.ts` → Reads raw_*, writes to normalized tables

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

### Architectural Fixes (During Migration)

These issues get fixed as part of the migration, not as separate work:

| Issue | Fix Phase | Solution |
|-------|-----------|----------|
| Customer duplicates | Phase 3 | PostgreSQL unique constraints + `ON CONFLICT` upserts |
| Missing indexes | Phase 3 | Created with normalized tables |
| Backfill race conditions | Phase 4 | PostgreSQL advisory locks |
| N+1 queries | Phase 4 | Batch reads in transform scripts |
| Silent API tracking loss | Phase 5 | Direct PostgreSQL writes (no buffer) |
| Rate limit handling | Phase 5 | Explicit error types in app layer |
| MongoDB connection issues | Phase 7 | PostgreSQL connection pooling |

---

## 10. Backfill Improvement Plan

**Priority:** High  
**Status:** Planning

### Overview
Improve the backfill system for faster new shop onboarding, real-time webhook updates, and smarter prefetch prioritization.

### Current Problems
- **Backward processing**: New shops wait days before recent data is indexed
- **No webhook sync**: Real-time updates from SMS not captured immediately
- **First-visit cold start**: User sees 10-20s loading spinner
- **500-mile threshold**: Mileage updates trigger full plan rebuild
- **Single-threaded**: One shop at a time, no parallelism

### Improvements

#### 1. Hot Start for New Shops
Process the **last 30 days first**, then backfill history.

```
NEW SHOP ONBOARDING:
Day 0: Sync last 30 days (immediate dashboard utility)
Day 1-3: Backfill 30-90 days
Day 3+: Continue historical backfill in background
```

#### 2. Webhook-Driven Real-Time Sync
When SMS sends webhook, immediately update:
- Customer record
- Vehicle mileage
- Active RO status
- Queue prefetch for that VIN

```
Webhook → Update normalized tables → Queue prefetch → Dashboard shows instantly
```

#### 3. Smarter Prefetch Queue
Prioritize by likelihood of being viewed:
1. **In-progress ROs** (highest priority)
2. **Recently updated vehicles** (webhook-triggered)
3. **Vehicles viewed in last 24 hours**
4. **Scheduled appointments for today/tomorrow**

#### 4. Incremental Plan Updates
Instead of rebuilding the entire plan when mileage changes:
- Update only `milesToGo` and `daysToGo` fields (fast: ~50ms)
- Only fetch new OEM data if crossing a service interval threshold
- Schedule full refresh async if needed

#### 5. Parallel Shop Processing
- Run up to 3 shops in parallel (respecting global rate limits)
- Use PostgreSQL advisory locks for coordination
- Separate worker pools per platform

### Implementation by Phase

| Phase | Improvement | How |
|-------|-------------|-----|
| Phase 3 | Hot Start | Add `hotStartCompleted` flag to shops table |
| Phase 4 | Parallel Processing | PostgreSQL advisory locks + worker pools |
| Phase 5 | Webhook Real-Time Sync | Update normalized tables directly on webhook |
| Phase 5 | Incremental Plan Updates | Separate `plan_summary` (fast) from `plan_details` (slow) |
| Phase 6 | Smarter Prefetch | Query PostgreSQL for active ROs + appointments |

### Expected Results

| Metric | Before | After |
|--------|--------|-------|
| New shop first data | Days | Minutes |
| First-visit load | 10-20s | <2s (cached) |
| Mileage update impact | Full rebuild | Incremental (~50ms) |
| Webhook → Dashboard | N/A | <5 seconds |
| Backfill completion | Days | Hours (parallel) |

---

## 11. Post-Migration Priorities

**Priority:** High  
**Status:** Planning

After database migration is complete, focus on these areas before adding new integrations:

### 11.1 Chrome Extension Fixes
The Tekmetric Chrome extension needs updates to work properly with web-based integrations:
- Side panel integration with maintenance recommendations
- Job history display within Tekmetric interface
- Sticker printing from Chrome extension
- Consistent behavior across all web-based SMS platforms
- **Add vehicle recalls to Plan tab** - Fetch and display safety recalls from `/api/vehicles/[vin]/recalls` in a dedicated section at the top of the Plan tab

### 11.2 Stripe Billing Verification
Ensure billing system is flawless before scaling:
- VIN-based billing accuracy (300 VINs included, then per-VIN charges)
- Trial limits enforcement
- Subscription management (upgrades, downgrades, cancellations)
- Invoice accuracy and payment processing
- Webhook handling for payment events
- Feature flags tied to subscription status

### 11.3 Documentation & Customer Success
Build comprehensive self-service resources:

**Walkthrough Tutorials:**
- Getting started / onboarding flow
- Connecting SMS integration (Tekmetric, Protractor, AutoFlow)
- Reading maintenance plans
- Using the Chrome extension
- Printing stickers and keytags
- Understanding billing

**Support Documents:**
- Troubleshooting common issues
- FAQ for each feature
- Integration-specific guides

**Knowledge Base:**
- Searchable help center
- AI chatbot training data (improves support bot responses)
- Video tutorials where helpful

**In-App Guidance:**
- Contextual tooltips
- First-time user tours
- Empty state messaging with next steps

---

## 12. Future Integration Expansion

**Priority:** Low  
**Status:** Idea

After post-migration priorities are complete, the normalized schema + adapter pattern enables rapid addition of new integrations.

### Potential New Integrations
- Shop-Ware, Mitchell 1, R.O. Writer (SMS platforms)
- Hunter (alignment equipment data)
- Snap-on (diagnostic tool data)
- Parts ordering (WorldPac, PartsAuth, etc.)

### Integration Adapter Pattern
Each new integration implements `ISMSAdapter` interface. Data flows through existing normalized tables; backfill/prefetch/cache systems work automatically.

**Estimated time per new SMS integration:** 2-3 days (vs weeks before normalization)

### Priority Order
1. DataOne Direct Integration (3-4 days)
2. Database Migration (9 weeks)
3. Chrome Extension Fixes
4. Stripe Billing Verification
5. Documentation & Tutorials
6. New Integrations

---

## Appendix: Development & Deployment Workflow

### Strategy: "Train How You Fight"
Three isolated environments, but QA mirrors production data for realistic testing.

### Environments

| Environment | Platform | Database | Stripe Mode | Purpose |
|-------------|----------|----------|-------------|---------|
| **Dev** | Replit | Replit PostgreSQL | Test | Active development, experimentation |
| **QA** | Render | QA PostgreSQL (prod mirror) | Test | Pre-production testing with real data patterns |
| **Prod** | Render | Production PostgreSQL | Live | Real customers (24 shops) |

### Render Service IDs
- **QA:** `srv-d5hb86i4d50c738vm4o0`
- **Prod:** `srv-d55jaqkhg0os73a5dd8g`

### Database Mirroring (Prod → QA)
Before testing migrations or major features, sync QA database from production:

```bash
# 1. Dump production database
pg_dump $PROD_DATABASE_URL --no-owner --no-acl > prod_backup.sql

# 2. Restore to QA database (destructive - replaces QA data)
psql $QA_DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql $QA_DATABASE_URL < prod_backup.sql

# 3. Verify row counts match
psql $PROD_DATABASE_URL -c "SELECT COUNT(*) FROM shops;"
psql $QA_DATABASE_URL -c "SELECT COUNT(*) FROM shops;"
```

**When to sync:**
- Before testing database migrations
- Before testing billing changes
- Weekly (recommended) to keep QA data fresh
- After major production data changes

### Deployment Flow

```
┌─────────────────────────────────────────────────────────┐
│  1. DEVELOP (Replit)                                    │
│     - Write code, test locally                          │
│     - Use Replit's PostgreSQL for dev data              │
│     - Stripe test mode for billing work                 │
└────────────────────────┬────────────────────────────────┘
                         │ Deploy to QA
                         ▼
┌─────────────────────────────────────────────────────────┐
│  2. TEST (Render QA)                                    │
│     - Sync prod data to QA database first               │
│     - Test with real data patterns                      │
│     - Verify migrations don't break anything            │
│     - Test billing flows (Stripe test mode)             │
└────────────────────────┬────────────────────────────────┘
                         │ Deploy to Prod (after QA passes)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  3. PRODUCTION (Render Prod)                            │
│     - Real customers, real data                         │
│     - Stripe live mode                                  │
│     - Monitor for issues                                │
└─────────────────────────────────────────────────────────┘
```

### Environment Variables by Environment

**Dev (Replit):**
- `DATABASE_URL` - Replit's built-in PostgreSQL
- `STRIPE_SECRET_KEY` - Test mode key (`sk_test_...`)
- `DEV_AUTO_LOGIN=true` - Skip auth for faster dev

**QA (Render):**
- `DATABASE_URL` - QA PostgreSQL (mirrored from prod)
- `STRIPE_SECRET_KEY` - Test mode key (`sk_test_...`)
- `NODE_ENV=production`

**Prod (Render):**
- `DATABASE_URL` - Production PostgreSQL
- `STRIPE_SECRET_KEY` - Live mode key (`sk_live_...`)
- `NODE_ENV=production`

### Pre-Deployment Checklist

**Before deploying to QA:**
- [ ] Code tested locally in Replit
- [ ] No console errors
- [ ] Database migrations tested (if any)

**Before deploying to Prod:**
- [ ] QA testing complete
- [ ] Database sync verified (if migration involved)
- [ ] Stripe billing flows verified (if billing changes)
- [ ] Chrome extension tested (if UI changes)
- [ ] Rollback plan ready

---

## Mobile Work Order Intake with Symptom Questionnaire

**Priority:** Medium  
**Status:** Planned

### Overview
Enable service advisors to start a Protractor work order directly from MOS Tools on a phone or tablet. The system guides them through a customizable set of symptom-based questions to capture detailed information about the customer's concerns, providing technicians with comprehensive diagnostic context before they even see the vehicle.

### Core Features

#### Mobile-First Work Order Creation
- Responsive UI optimized for phone/tablet use
- Quick customer lookup (by phone, name, or license plate)
- Quick vehicle lookup (by VIN, license plate, or customer history)
- Create new customer/vehicle if not found
- Push work order directly to Protractor via API

#### Symptom-Based Questionnaire System
- **Dynamic question flow** - Next question depends on previous answers
- **Category-based symptoms:**
  - Engine/Performance (check engine light, stalling, rough idle, etc.)
  - Brakes (noise, pedal feel, pulling, warning light)
  - Steering/Suspension (vibration, pulling, noise, handling)
  - HVAC (A/C, heat, blower, odors)
  - Electrical (battery, lights, accessories)
  - Noise/Vibration (when does it occur, speed, conditions)
  - Fluid Leaks (color, location, frequency)
  
#### Smart Follow-Up Questions
Example flow for "Brake Noise":
1. Where is the noise? (Front / Rear / Both / Unsure)
2. What type of noise? (Squealing / Grinding / Clicking / Thumping)
3. When does it occur? (Braking / Coasting / Both)
4. How long has this been happening? (Just started / Few days / Weeks / Months)
5. Any other symptoms? (Vibration / Pulling / Warning light)

#### Customizable Question Templates
- Shop admins can create/edit question templates
- Templates can be shared across enterprise locations
- Questions tagged by symptom category
- Support for:
  - Multiple choice
  - Yes/No
  - Text input
  - Photo upload (customer can show damage/leak)
  - Voice memo transcription

### Technical Implementation

#### API Integration
- `POST /api/protractor/work-orders` - Create new work order
- Attach symptom questionnaire results to work order notes
- Link photos/voice memos to work order

#### Data Storage
- Questionnaire templates stored in MongoDB
- Completed questionnaires linked to work order ID
- Analytics on common symptoms by vehicle type

#### Mobile UI
- Progressive Web App (PWA) for offline capability
- Large touch targets for easy tablet use
- Auto-save progress (don't lose data if interrupted)

### Benefits for Technicians
- Know what to look for before the vehicle arrives
- Customer's own words captured accurately
- Photos of issues taken at intake
- Reduces back-and-forth with advisor

### Future Enhancements
- AI-suggested diagnostic codes based on symptoms
- Historical symptom patterns for vehicle (recurring issues)
- Customer self-service intake (pre-arrival questionnaire via text/email)
- Voice-to-text for hands-free symptom capture
- Integration with DVI tools (AutoVitals)

---

## AI Sales Script Generator

**Priority:** Medium  
**Status:** Planned

### Overview
Add a 5th icon to the vehicle dashboard row that generates AI-powered sales scripts for service advisors. When clicked, it fetches the active work order from Protractor and uses AI to create personalized talking points to help advisors present and sell recommended services.

### Data Available from Protractor Work Order
- **Customer Info:** First name, last name
- **Vehicle Info:** Year, make, model, VIN, current mileage
- **Services on Ticket:** Job titles, descriptions, prices, parts/labor breakdown
- **Inspection Results:** Findings, pass/fail status, notes, photos

### Feature Requirements

#### User Flow
1. Advisor clicks "Sales Script" icon on vehicle row in dashboard
2. System prompts for RO number (or auto-detects if active work order exists)
3. Fetches full work order details from Protractor API
4. Passes data through custom AI prompt
5. Displays generated sales script with talking points

#### AI Prompt Considerations
- Personalize with customer name and vehicle details
- Prioritize safety-critical items first
- Include price context and value propositions
- Suggest urgency levels (immediate vs. can wait)
- Keep language conversational and non-pushy

#### UI/UX
- New icon in vehicle row action buttons (5th icon)
- Modal or slide-out panel showing the script
- Option to regenerate with different tone/approach
- Copy to clipboard functionality

### Technical Implementation
- New API endpoint: `/api/protractor/sales-script`
- Calls `fetchWorkOrderById()` to get full work order data
- Uses OpenAI integration with custom prompt template
- Prompt template stored in shop settings (customizable per shop)

### Future Enhancements
- Save generated scripts to work order history
- Track conversion rates (script generated → service sold)
- A/B test different prompt styles
- Add shop-specific terminology/branding

---

## Work Order Audit / Repair Verification

**Priority:** Medium  
**Status:** Planned  

### Overview
An on-demand "Verify" feature that reviews a work order before the service advisor calls the customer to sell the work. It checks correctness of all parts, identifies missing items, and uses AI to ensure the best repair is being recommended for the customer.

### Requirements

#### Trigger & Location
- On-demand button (e.g., "Verify Work Order") — not automatic
- Accessed as a review step before calling the client to present the repair
- Should work in both the dashboard and Chrome extension

#### Data Sources
- **Job/Part Pairing Lists:** Shop-provided reference lists mapping common jobs to their expected parts (uploaded/managed by the shop)
- **AI Layer:** OpenAI-powered analysis on top of the reference lists to catch contextual issues the lists alone can't identify (vehicle age, mileage, repair history, industry best practices)

#### Verification Checks
- **Missing parts:** Flag parts typically required for the job that aren't on the RO
- **Incorrect fitment:** Parts that don't match the vehicle's year/make/model/engine
- **Better alternatives:** Suggest OE vs aftermarket options, updated superseded part numbers
- **Companion repairs:** Common jobs that should be done together (e.g., water pump with timing belt)
- **Pricing anomalies:** Flag unusually high or low pricing compared to typical ranges

#### UI / Output
- Checklist-style display with color-coded indicators:
  - **Green:** Looks good / verified correct
  - **Yellow:** Suggestion or optional improvement
  - **Red:** Potential problem or missing item
- Each item shows a brief explanation of why it was flagged

#### SMS Integration
- Must support Tekmetric and Protractor, extensible for future SMS providers
- Pull RO data (jobs, parts, vehicle info, customer) from the active SMS

#### Future Enhancements
- Learning from shop corrections over time (feedback loop)
- Shop-specific part preferences and vendor mappings
- Integration with parts supplier APIs for real-time availability/pricing

---

## Bulk Add Plan Items to RO

**Priority:** High  
**Status:** Planned

### Overview
One-click injection of all overdue/due soon plan items from the Chrome extension into the repair order.

### Key Considerations
- **Tekmetric**: Each item needs to match a canned job in the shop's catalog. Items without a match could be skipped with a summary shown to the user. Consider a checklist UI where the advisor reviews and unchecks items before submitting.
- **Shop-Ware**: Simpler for findings (just text). For "Add Service" mode, would need canned job search like single-add does today.
- **UX options**: One-click "add all" vs. checklist approach where advisor can deselect items before injecting.

---

## DVI / Inspection Auto-Fill from VHI

**Priority:** High  
**Status:** Planned

### Overview
Use the VHI plan data (OEM schedule, CARFAX history, shop work order history, deferred work) to automatically populate DVI inspection items in Tekmetric and potentially AutoFlow. This reverses the current data flow — currently DVI feeds *into* the VHI, this feature would have VHI intelligence feed *out to* the DVI so techs see what's due/overdue before they even start inspecting.

### API Research Needed
- **Tekmetric**: Check if `/inspections` endpoint supports POST/PUT to create or update inspection items (currently only GET is used via `getRepairOrderInspections` in `lib/integrations/tekmetric/client.ts`). If not writable via API, fall back to DOM-based injection via extension content script.
- **AutoFlow**: Check if their API exposes any write endpoints for DVI findings. Extension already supports AutoFlow for context detection — could extend for DVI write-back.

### Proposed Flow
1. When a VHI plan is built/loaded for a vehicle on an open RO, identify overdue and due-soon items.
2. Match those items to existing DVI template line items using service key mappings (same `SERVICE_KEY_PATTERNS` used for dedup).
3. Pre-flag matched DVI items as needing attention (e.g., set status to "marginal" or "needs inspection").
4. Unmatched VHI items that don't exist in the DVI template could be added as custom findings or notes.

### Key Considerations
- **Write permissions**: Shops must opt in — auto-filling DVI items without consent could be disruptive.
- **Timing**: Should trigger when the tech opens the DVI, not when the plan is built (avoid stale data).
- **Conflict resolution**: If a DVI item is already marked "good" by the tech, VHI should not override it.
- **Matching logic**: The existing OEM-to-CARFAX service mappings and `SERVICE_KEY_PATTERNS` provide the foundation for matching plan items to inspection line items.

---

## 18. Mobile Sticker Printing (Android Support)

**Priority:** Medium  
**Status:** Planned

### Overview
Build a mobile-friendly web page for oil sticker printing to overcome the Zink Happy printer's iOS-only limitation. Android users currently cannot print stickers from the Chrome extension workflow.

### Approach
- Leverage existing server-side sticker image generation (`node-canvas` via `lib/canvas-renderer.ts`)
- Mobile-optimized web page that takes vehicle/service info and generates sticker images
- User downloads the sticker image and prints via Android's built-in print system (supports Wi-Fi and Bluetooth printers)
- Alternative: Web Bluetooth API for direct thermal printer communication from browser

### Open Questions
- Authentication: MOS login credentials vs. link/QR code access?
- Data entry: Manual vehicle info input vs. pulling from existing shop data (open ROs from Tekmetric, etc.)?
- Scope: Oil stickers only initially, or include keytags?
- Broader context: User is considering making the entire platform mobile-friendly — this could serve as a first step/proof of concept

### Key Considerations
- No native app required — mobile web page using existing sticker generation backend
- Existing sticker API already generates images server-side, so the mobile page just needs to call it and present the result
- Could support any printer that Android's print system recognizes (Wi-Fi, Bluetooth)
- If the full platform goes mobile-friendly later, this page would integrate into the broader mobile experience

---

## Denormalize Protractor Work Orders (Eliminate $lookup)

**Priority:** Medium  
**Status:** Planned

### Overview
Protractor work order queries currently use MongoDB `$lookup` to join vehicle and customer data from separate collections (`protractor_vehicles`, `protractor_customers`) at query time. This accounts for over 50% of detected slow operations on the `protractor_work_orders` collection per Atlas Performance Advisor. The fix is to denormalize — embed vehicle (year/make/model/VIN) and customer (name/phone) data directly on the work order document during sync, matching the pattern already used for Tekmetric work orders.

### Affected Files
- Protractor sync logic (webhook handler + daily sync cron)
- `app/api/dashboard/data/route.ts` — `$lookup` to `protractor_vehicles` for vehicle details
- `app/api/jobs/open-work-orders/route.ts` — `$lookup` to `protractor_vehicles`
- `app/api/internal/prefetch-vehicles/route.ts` — `$lookup` to `protractor_vehicles`

### Implementation Steps
1. During Protractor work order sync (webhook + cron), resolve vehicle/customer data and embed it directly on the work order document (e.g., `vehicleName`, `vehicleYear`, `vehicleMake`, `vehicleModel`, `customerName`, `customerPhone`)
2. Write a one-time backfill script to populate existing work order documents
3. Update the three query files to read embedded fields instead of `$lookup`
4. Remove the `$lookup` stages from all aggregation pipelines

---

## Notes

- Features should be discussed before implementation
- Update this document when new items are identified
- Mark items as "In Progress" or "Completed" as work progresses

---

*Last Updated: March 2, 2026*
