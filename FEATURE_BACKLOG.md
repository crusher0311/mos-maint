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
Use CARFAX service history data to estimate current vehicle mileage when odometer reading is unavailable or outdated.

---

## 4. Service History Timeline

**Priority:** Medium  
**Status:** Idea

### Overview
Visual timeline display of all service history for a vehicle, combining data from CARFAX, shop records, and DVI inspections.

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
Compare deferred/declined work against CARFAX records to identify services that were later performed elsewhere.

---

## 8. MongoDB to PostgreSQL Migration

**Priority:** High  
**Status:** Planning

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

---

## Notes

- Features should be discussed before implementation
- Update this document when new items are identified
- Mark items as "In Progress" or "Completed" as work progresses

---

*Last Updated: January 31, 2026*
