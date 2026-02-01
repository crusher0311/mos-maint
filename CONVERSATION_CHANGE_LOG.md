# Conversation Change Log

This file tracks migration sessions, key decisions, and checkpoint history for the MongoDB to PostgreSQL migration project.

---

## Session: 2026-02-01

### Checkpoint: 7e9f238bedc56dca441964f27b30d56b5d8772a2
**Summary:** Migrate integration services to use PostgreSQL instead of MongoDB
- Updates Autovitals, Carfax, and DVI integrations to use PostgreSQL
- Replaces MongoDB data access with SQL queries
- Updates type definitions and normalizes data fetching

### Checkpoint: 5724daa7f4d04dfbb6d6d8002f29694c261c59eb
**Summary:** Migrate core utility libraries to use PostgreSQL database
- Replace MongoDB queries with SQL statements in `lib/data-quality.ts`, `lib/evidence.ts`, `lib/ids.ts`, and `lib/rate.ts`
- Update customer model upsert logic in `lib/models/customers.ts` to use PostgreSQL

### Files Migrated This Session:
- `lib/rate.ts` - Rate limiting with bucket-based approach, added TTL cleanup
- `lib/evidence.ts` - VIN evidence builder for DVI, CARFAX, OE schedule data
- `lib/data-quality.ts` - Data quality checks and auto-cleanup
- `lib/ids.ts` - Counter service for sequential shop IDs (atomic INSERT...ON CONFLICT)
- `lib/models/customers.ts` - Customer upsert logic from AutoFlow events
- `lib/integrations/carfax.ts` - CARFAX vehicle history with cache
- `lib/integrations/dvi.ts` - Digital vehicle inspections from AutoFlow
- `lib/integrations/autovitals.ts` - AutoVitals integration (vehicles, appointments, inspections)
- `lib/integrations/autoflow.ts` - AutoFlow DVI fetching and caching
- `lib/integrations/dataone.ts` - DataOne OE service schedules

### Key Decisions:
1. **Atomic operations:** Use single-statement upserts with ON CONFLICT for critical operations
2. **Rate limiting:** Includes automatic cleanup of expired entries with DELETE WHERE expires_at < NOW()
3. **Counter service:** Uses atomic INSERT...ON CONFLICT DO UPDATE RETURNING seq
4. **Shop ID handling:** shop_id is text in PostgreSQL, numeric in MongoDB - requires String() conversion
5. **JSONB usage:** Use ${JSON.stringify(data)}::jsonb for complex objects in PostgreSQL

### Issues Identified by Architect:
- Customer upserts non-atomic (multiple SELECTs followed by UPDATE/INSERT) - potential concurrency issue
- Data quality autoCleanup uses per-row updates in loop (inefficient vs single UPDATE with IN/ANY)

### Migration Progress:
- Started session: ~174 MongoDB files remaining
- Current: ~169 MongoDB files remaining
- New PostgreSQL tables: shop_features, ratelimits, counters, carfax_reports, dvi, dvi_results, dataone_oe, autovitals_vehicles, autovitals_appointments, autovitals_inspections

---

## Previous Sessions Summary

### Phase 1-4 (Completed):
- PostgreSQL schema created (109 tables)
- Dual-write ingestion (Tekmetric/Protractor sync writes to both DBs)
- Historical data migrated: 309,781 customers, 167,803 vehicles, 497,216 work orders
- PostgreSQL data access layers created for customers, vehicles, work orders, shops, users, sessions

### Phase 5 (In Progress):
- API routes being migrated
- Core libraries migrated
- Integration files migrated

---

## Migration Patterns Reference

### Shop ID Mapping:
MongoDB integer `shopId` → PostgreSQL UUID via `shops.shop_id` (text) column

### Query Safety:
All queries use parameterized `sql` tagged templates for injection safety

### Upserts:
Use `ON CONFLICT` with `COALESCE` for partial updates

### VIN Handling:
VINs normalized to uppercase before storage

---

## Notes for Future Sessions:
- ~171 files still reference MongoDB
- Priority areas: dashboard routes, cron jobs, vehicle analyzer, stickers, parts
- Final phase will remove MongoDB dependencies completely
