# Deprecated Files & Migration Guide

**Last Updated:** January 25, 2026

This document tracks deprecated files in the MOS Tools codebase and their modular replacements. Legacy files are kept for backward compatibility but should not be used for new development.

---

## Status Legend

| Status | Meaning |
|--------|---------|
| **DEPRECATED** | File still works but should not be used for new code |
| **LEGACY** | File is actively being phased out |
| **REMOVED** | File has been deleted (listed for reference) |

---

## Integration Layer Deprecations

### Protractor Integration

| Legacy File | Status | Replacement | Notes |
|-------------|--------|-------------|-------|
| `lib/integrations/protractor.ts` | DEPRECATED | `lib/integrations/protractor/` module | 88KB monolith split into focused files |
| `lib/integrations/protractor-backfill.ts` | DEPRECATED | `lib/integrations/protractor/sync.ts` | Backfill logic moved to module |
| `lib/integrations/protractor-legacy.ts` | LEGACY | N/A | Temporary re-export shim |

**Migration:**
```typescript
// OLD (deprecated)
import { fetchWorkOrderById, getVehicleByVin } from '@/lib/integrations/protractor';

// NEW (recommended)
import { protractorAdapter } from '@/lib/integrations/protractor';
const result = await protractorAdapter.getWorkOrder(shopId, workOrderId);
const vehicle = await protractorAdapter.getVehicleByVin(shopId, vin);

// Or use the facade for auto-detection
import { integrationFacade } from '@/lib/integrations';
const adapter = await integrationFacade.getConfiguredAdapter(shopId);
```

---

### Tekmetric Integration

| Legacy File | Status | Replacement | Notes |
|-------------|--------|-------------|-------|
| `lib/tekmetric.ts` | DEPRECATED | `lib/integrations/tekmetric/client.ts` | API calls moved to module |
| `lib/tekmetric-auth.ts` | DEPRECATED | `lib/integrations/tekmetric/auth.ts` | OAuth logic moved to module |
| `lib/tekmetric-sync.ts` | DEPRECATED | `lib/integrations/tekmetric/` | Sync utilities in module |
| `lib/tekmetric-incremental-sync.ts` | DEPRECATED | `lib/integrations/tekmetric/` | Consider integrating |
| `lib/tekmetric-job-index.ts` | DEPRECATED | Shared job index | May stay separate |
| `lib/tekmetric-usage-tracker.ts` | DEPRECATED | `lib/api-usage-tracker.ts` | Consolidate with shared tracker |

**Migration:**
```typescript
// OLD (deprecated)
import { getTekmetricRepairOrders } from '@/lib/tekmetric';
import { refreshTekmetricToken } from '@/lib/tekmetric-auth';

// NEW (recommended)
import { tekmetricAdapter } from '@/lib/integrations/tekmetric';
const result = await tekmetricAdapter.getWorkOrders(shopId, options);

// Or use the facade
import { integrationFacade } from '@/lib/integrations';
const adapter = await integrationFacade.getConfiguredAdapter(shopId);
```

---

### AutoFlow Integration

| Legacy File | Status | Replacement | Notes |
|-------------|--------|-------------|-------|
| `lib/integrations/autoflow.ts` | DEPRECATED | `lib/integrations/autoflow/` module | DVI integration modularized |
| `lib/integrations/autoflow-legacy.ts` | LEGACY | N/A | Temporary re-export shim |

**Migration:**
```typescript
// OLD (deprecated)
import { getAutoFlowDVI } from '@/lib/integrations/autoflow';

// NEW (recommended)
import { autoflowAdapter } from '@/lib/integrations/autoflow';
const result = await autoflowAdapter.getDVI(shopId, vehicleId);
```

---

## Files NOT Deprecated (Keep As-Is)

These files remain the source of truth and are not deprecated:

| File | Reason |
|------|--------|
| `lib/integrations/index.ts` | Main entry point for modular architecture |
| `lib/integrations/core/*` | Foundation layer (types, facade, rate-limiter) |
| `lib/integrations/protractor/*` | New modular Protractor code |
| `lib/integrations/tekmetric/*` | New modular Tekmetric code |
| `lib/integrations/autoflow/*` | New modular AutoFlow code |
| `lib/normalized-schema.ts` | Shared schema definitions |
| `lib/api-usage-tracker.ts` | Cross-cutting usage tracking |
| `lib/mongo.ts` | Core database connection |
| `lib/job-index.ts` | Shared job indexing |
| `lib/integrations/carfax.ts` | Not yet modularized |
| `lib/integrations/dataone.ts` | Not yet modularized |
| `lib/integrations/dataone-api.ts` | Not yet modularized |
| `lib/integrations/autovitals.ts` | Not yet modularized |
| `lib/integrations/dvi.ts` | Not yet modularized |

---

## How to Add New Integrations

Follow the modular pattern in `lib/integrations/{provider}/`:

```
lib/integrations/{provider}/
├── types.ts      # Provider-specific types
├── client.ts     # API client functions
├── transform.ts  # Data transformation to normalized format
├── adapter.ts    # IIntegrationAdapter implementation
└── index.ts      # Module exports, auto-registers with facade
```

See `lib/integrations/protractor/` as the reference implementation.

---

## Deprecation Timeline

| Phase | Target Date | Action |
|-------|-------------|--------|
| Phase 1 | Complete | Add deprecation notices to legacy files |
| Phase 2 | **Complete** | Migrate all API routes to use modular imports |
| Phase 3 | Complete | Runtime warnings removed (modular re-exports used instead) |
| Phase 4 | TBD | Remove legacy files after verification period |

### Migration Approach

Legacy files are now used as **backing implementations** for the modular indexes:

```
Import Path Resolution:
@/lib/integrations/protractor  → lib/integrations/protractor/index.ts (modular)
                                  ↳ Re-exports from lib/integrations/protractor.ts (legacy)

@/lib/integrations/tekmetric   → lib/integrations/tekmetric/index.ts (modular)  
                                  ↳ Re-exports from lib/tekmetric.ts (legacy)

@/lib/integrations/autoflow    → lib/integrations/autoflow/index.ts (modular)
                                  ↳ Re-exports from lib/integrations/autoflow.ts (legacy)
```

**Benefits:**
- All API routes now import from modular paths
- No runtime deprecation warnings in development
- Legacy code continues to work as backing implementation
- Gradual migration path to pure modular implementation

### API Routes Migration Status

**All routes migrated** - Routes now use modular imports:
- `@/lib/integrations/protractor` - All Protractor routes ✓
- `@/lib/integrations/tekmetric` - All Tekmetric routes ✓
- `@/lib/integrations/autoflow` - All AutoFlow routes ✓

---

## Questions?

When modifying integration code:
1. **New features** → Add to the modular structure (`lib/integrations/{provider}/`)
2. **Bug fixes** → Fix in both legacy AND modular if both are still used
3. **Refactoring** → Work in modular structure only

The goal is to gradually migrate all consumers to the new modules, then safely remove legacy files.
