# Feature Backlog

This document tracks planned features and enhancements for MOS Maintenance MVP.

---

## 1. Stripe Billing Robustness

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

## 2. MongoDB to PostgreSQL Migration

**Priority:** High  
**Status:** Planned

### Overview
Migrate core relational data from MongoDB Atlas to PostgreSQL for improved performance, data integrity, and simpler querying. MongoDB will remain for caching purposes.

### Migration Phases

#### Phase 1: Schema Design
- Design PostgreSQL schema for all core entities
- Map MongoDB collections to PostgreSQL tables:
  - `shops` → `shops` table
  - `users` → `users` table
  - `vehicles` → `vehicles` table (if applicable)
  - `billing records` → `billing` table
  - `feature flags` → `feature_flags` table
  - `audit_log` → `audit_logs` table
  - `platform_settings` → `platform_settings` table
- Define foreign key relationships
- Create indexes for common queries

#### Phase 2: Data Access Layer
- Create Drizzle ORM schema definitions
- Build repository pattern for each entity
- Create migration scripts for existing data
- Implement dual-write during transition (write to both MongoDB and PostgreSQL)

#### Phase 3: Read Migration
- Switch reads from MongoDB to PostgreSQL for each entity (one at a time)
- Validate data consistency between both databases
- Monitor performance

#### Phase 4: Write Migration
- Switch writes from MongoDB to PostgreSQL
- Remove dual-write code
- Keep MongoDB for:
  - Caching (plan_cache, dataone_cache)
  - Session data (if applicable)
  - Any document-heavy data that benefits from flexible schema

#### Phase 5: Cleanup
- Remove MongoDB queries for migrated entities
- Update all API routes to use PostgreSQL
- Archive MongoDB collections (keep for rollback safety)
- Update documentation

### Entities to Migrate
| MongoDB Collection | PostgreSQL Table | Priority |
|--------------------|------------------|----------|
| `shops` | `shops` | High |
| `users` | `users` | High |
| `platform_settings` | `platform_settings` | High |
| `audit_log` | `audit_logs` | Medium |
| `stripe_webhook_events` | `stripe_events` | Medium |
| `pending_signups` | `pending_signups` | Medium |
| `vin_usage` | `vin_usage` | Medium |
| `support_tickets` | `support_tickets` | Low |
| `notifications` | `notifications` | Low |

### Keep in MongoDB (Caching)
- `plan_cache` - Vehicle maintenance plan cache
- `dataone_cache` - VIN decoding/OEM schedule cache
- `carfax_cache` - CARFAX response cache
- `dvi_cache` - DVI inspection cache

### Technical Considerations
- Use Drizzle ORM for PostgreSQL (already in project)
- Implement transactions for multi-table operations
- Create data validation scripts to ensure consistency
- Plan for zero-downtime migration with feature flags

### Rollback Plan
- Keep MongoDB running in parallel for 30 days post-migration
- Feature flag to switch back to MongoDB if issues arise
- Daily consistency checks during transition

---

## 3. [Add Next Feature Here]

**Priority:** TBD  
**Status:** Planned

---

## Notes

- Features should be discussed before implementation
- Update this document when new items are identified
- Mark items as "In Progress" or "Completed" as work progresses

---

*Last Updated: January 31, 2026*
