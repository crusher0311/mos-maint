# PostgreSQL Migration Plan

**Status:** Future Task  
**Created:** January 25, 2026  
**Priority:** Medium - Complete before heavy user adoption

## Overview

This document outlines a hybrid database architecture migration plan to move consistency-critical data from MongoDB to PostgreSQL while keeping document-heavy integration cache data in MongoDB.

## Current State

The application uses MongoDB Atlas as the sole database. Analysis identified 40+ collections with varying requirements for data consistency vs. flexibility.

## Proposed Hybrid Architecture

### Move to PostgreSQL (Relational, Consistency-Critical)

| Collection | Current References | Reason to Move |
|------------|-------------------|----------------|
| `users` | 65 | Auth, roles, permissions - needs strong consistency |
| `shops` | 263 | Core config, billing relationships, foreign keys |
| `sessions` | 22 | Auth sessions - transactional integrity |
| `enterprise_accounts` | 28 | Enterprise relationships, multi-shop management |
| `support_tickets` | 21 | Customer support tracking |
| `audit_logs` | 10 | Compliance, immutable records |
| `feature_flags` | - | Shop entitlements, billing integration |
| `billing/subscriptions` | - | Stripe data, payment records |

### Keep in MongoDB (Document-Heavy, Cache Data)

| Collection | Reason to Keep |
|------------|----------------|
| `vehicles`, `customers` | Integration data from SMS providers, varied schemas |
| `tekmetric_work_orders`, `protractor_work_orders` | External API cache |
| `job_index` | Text search, full-text indexes |
| `events` | High-write event stream |
| `notifications` | Transient, high-volume |
| `All *_cache collections` | External API response caching |
| `normalized_work_orders` | Denormalized for performance |

## Migration Phases

### Phase 1: Schema Design (2-3 days)
- Create PostgreSQL tables using Drizzle ORM
- Define foreign key relationships
- Set up connection pooling
- Tables: users, shops, sessions, enterprise_accounts, audit_logs

### Phase 2: Data Backfill (1-2 days)
- Write migration scripts to copy existing MongoDB data
- Validate data integrity post-migration
- Create indexes on PostgreSQL tables

### Phase 3: Dual-Write Implementation (3-5 days)
- Modify repository layer to write to both databases
- Add feature flag to control which database is primary
- Implement consistency checks between stores

### Phase 4: Read Migration (3-5 days)
- Update API routes to read from PostgreSQL
- Test all affected endpoints
- Monitor for performance regressions
- Keep MongoDB as fallback

### Phase 5: Cleanup (1-2 days)
- Remove dual-write code
- Drop migrated MongoDB collections
- Update documentation
- Archive migration scripts

## Estimated Effort

**Total: 10-17 days of development**

## PostgreSQL Schema (Draft)

```sql
-- Users table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'user',
  shop_id INTEGER REFERENCES shops(shop_id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Shops table
CREATE TABLE shops (
  shop_id INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255),
  webhook_token VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active',
  stripe_customer_id VARCHAR(255),
  enterprise_id INTEGER REFERENCES enterprise_accounts(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enterprise accounts
CREATE TABLE enterprise_accounts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit logs
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  admin_email VARCHAR(255),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(100),
  target_id VARCHAR(255),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Support tickets
CREATE TABLE support_tickets (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(shop_id),
  user_id INTEGER REFERENCES users(id),
  subject VARCHAR(500) NOT NULL,
  status VARCHAR(50) DEFAULT 'open',
  priority VARCHAR(50) DEFAULT 'normal',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

## Key Considerations

### Cross-Database References
- Use `shopId` as the consistent key between PostgreSQL and MongoDB
- PostgreSQL owns the source of truth for shop existence
- MongoDB references shopId but doesn't enforce foreign keys

### Rollback Strategy
- Keep MongoDB collections intact for 2 weeks after migration
- Feature flag to switch back to MongoDB reads if issues arise
- Daily backup validation during transition

### Performance Monitoring
- Compare query latencies before/after migration
- Monitor PostgreSQL connection pool usage
- Track any cross-database query patterns

## Prerequisites

1. PostgreSQL database available (already configured via Replit)
2. Drizzle ORM installed and configured
3. Feature flag system in place
4. Monitoring/alerting for database health

## Success Criteria

- [ ] All user authentication flows work with PostgreSQL
- [ ] Shop CRUD operations are transactionally consistent
- [ ] Audit logs capture all admin actions
- [ ] No data loss during migration
- [ ] Response times equal or better than MongoDB
- [ ] Zero downtime during cutover

## Notes

- The existing Replit PostgreSQL database is available via `DATABASE_URL`
- Stripe integration already uses external IDs, no migration needed for payment data
- Consider running Phase 1-2 in a development branch for testing
