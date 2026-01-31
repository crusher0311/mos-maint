# Feature Backlog

This document tracks planned features and enhancements for MOS Maintenance MVP.

---

## 1. Robust Stripe Billing with Grace Periods

**Priority:** High  
**Status:** Planned

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
**Status:** Idea

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

## 8. MongoDB to PostgreSQL Migration

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

## 9. Backfill Improvement Plan

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

## 10. Post-Migration Priorities

**Priority:** High  
**Status:** Planning

After database migration is complete, focus on these areas before adding new integrations:

### 10.1 Chrome Extension Fixes
The Tekmetric Chrome extension needs updates to work properly with web-based integrations:
- Side panel integration with maintenance recommendations
- Job history display within Tekmetric interface
- Sticker printing from Chrome extension
- Consistent behavior across all web-based SMS platforms

### 10.2 Stripe Billing Verification
Ensure billing system is flawless before scaling:
- VIN-based billing accuracy (300 VINs included, then per-VIN charges)
- Trial limits enforcement
- Subscription management (upgrades, downgrades, cancellations)
- Invoice accuracy and payment processing
- Webhook handling for payment events
- Feature flags tied to subscription status

### 10.3 Documentation & Customer Success
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

## 11. Future Integration Expansion

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
1. Database Migration (9 weeks)
2. Chrome Extension Fixes
3. Stripe Billing Verification
4. Documentation & Tutorials
5. New Integrations

---

## Notes

- Features should be discussed before implementation
- Update this document when new items are identified
- Mark items as "In Progress" or "Completed" as work progresses

---

*Last Updated: January 31, 2026*
