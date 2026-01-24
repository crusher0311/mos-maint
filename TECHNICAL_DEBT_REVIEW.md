# MOS Tools - Technical Debt Review & Modular Architecture Plan

**Date:** January 24, 2026  
**Codebase Stats:** ~414,000 lines TypeScript, 244 API routes, 8 integrations

---

## Executive Summary

The MOS Tools platform has grown organically into a comprehensive automotive shop management system. While functional, the architecture has accumulated technical debt that creates coupling between integrations, making it difficult to work on one integration (e.g., Tekmetric) without affecting others.

This document identifies the key issues and proposes a modular architecture that enables:
- **Independent integration development** - Work on Tekmetric without touching Protractor
- **Easier testing** - Mock one integration without affecting others
- **Cleaner separation of concerns** - Each integration is self-contained
- **Simplified onboarding** - New developers can understand one integration at a time

---

## Part 1: Technical Debt Inventory

### Critical Issues (High Priority)

#### 1. **Monolithic Integration Files** 🔴
| File | Lines | Issue |
|------|-------|-------|
| `lib/integrations/protractor.ts` | 2,671 | Single file handles API calls, caching, rate limiting, data transformation |
| `lib/normalized-adapters.ts` | 1,204 | All SMS adapters in one file |
| `lib/normalized-ingestion.ts` | 1,330 | Ingestion logic coupled across all systems |
| `lib/normalized-schema.ts` | 1,501 | Good - but could be split by domain |
| `lib/api-usage-tracker.ts` | 834 | Tracks all APIs in one place (acceptable) |

**Impact:** Changing Protractor code risks breaking Tekmetric; hard to test in isolation.

#### 2. **Direct DB Access in Integration Layer** 🔴
46 instances of `getDb()` calls scattered across integration files.

```typescript
// Current pattern (lib/integrations/protractor.ts)
const db = await getDb();
const shop = await db.collection("shops").findOne({ shopId });
```

**Impact:** Integrations are tightly coupled to MongoDB schema; no abstraction for testing.

#### 3. **Inconsistent SMS Adapter Implementation** 🟡
- `ISMSAdapter` interface exists in `lib/sms-adapter.ts`
- Only Protractor has a proper adapter (`lib/sms-adapters/protractor-adapter.ts`)
- Tekmetric uses direct imports, no adapter
- AutoFlow uses direct imports, no adapter

**Impact:** No unified way to switch between integrations.

#### 4. **Duplicate Data Transformation Logic** 🟡
Multiple places transform the same data:
- `lib/sms-adapters/protractor-adapter.ts` transforms work orders
- `lib/normalized-adapters.ts` has `ProtractorAdapter` class
- `lib/integrations/protractor.ts` has inline transformations

**Impact:** Bug fixes need to be applied in multiple places.

#### 5. **Feature Flags Scattered Across Codebase** 🟡
Feature resolution logic in:
- `lib/featureResolver.ts` (main)
- `lib/features.ts` (types)
- Various API routes check features directly

**Impact:** Inconsistent feature gating; hard to add new features.

---

### Medium Issues (Should Address)

#### 6. **No Integration Interface Contract** 🟠
Each integration exposes different functions with different signatures:
```typescript
// Protractor
export function fetchWorkOrderById(shopId, workOrderId, config?)
// Tekmetric
export function getRepairOrders(shopId)
// AutoFlow
export function getWorkOrders(shopId, options)
```

**Impact:** Code calling integrations must know which one is active.

#### 7. **Rate Limiting Not Abstracted** 🟠
Each integration has its own rate limiting:
- Protractor: Local queue + distributed limiter
- Tekmetric: Uses `acquireDistributedRateLimitSlot`
- No abstraction layer

#### 8. **Backfill Logic Duplicated** 🟠
- `lib/integrations/protractor-backfill.ts` - Protractor specific
- `lib/tekmetric-incremental-sync.ts` - Tekmetric specific
- `lib/tekmetric-job-index.ts` - Job indexing for Tekmetric
- `lib/job-index.ts` - Shared but has Protractor-specific code

#### 9. **Test Coverage Unknown** 🟠
- E2E tests exist (`tests/e2e/`)
- No unit tests for individual integrations
- No integration tests with mocked external APIs

---

### Low Priority (Nice to Have)

#### 10. **TypeScript Any Types** 🟢
Many `any` types in transformation functions, especially in adapters.

#### 11. **Error Handling Inconsistency** 🟢
Some functions return `{ ok: boolean; error?: string }`, others throw.

#### 12. **Console.log Debugging** 🟢
Production code has `console.log` statements for debugging.

---

## Part 2: Current Architecture (As-Is)

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Routes                               │
│  (244 routes, directly import integration functions)             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Integration Layer (Tightly Coupled)           │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ protractor.ts   │  │ tekmetric.ts    │  │ autoflow.ts     │  │
│  │ (2,671 lines)   │  │ (558 lines)     │  │ (360 lines)     │  │
│  │                 │  │                 │  │                 │  │
│  │ - API calls     │  │ - API calls     │  │ - API calls     │  │
│  │ - Rate limiting │  │ - Rate limiting │  │ - Transform     │  │
│  │ - Caching       │  │ - Transform     │  │                 │  │
│  │ - Transform     │  │                 │  │                 │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  │
│           │                    │                    │            │
│           └────────────────────┼────────────────────┘            │
│                                │                                 │
│  ┌─────────────────────────────▼─────────────────────────────┐  │
│  │              Shared but Coupled Libraries                  │  │
│  │  normalized-adapters.ts │ normalized-ingestion.ts          │  │
│  │  job-index.ts │ common-failures.ts │ api-usage-tracker.ts  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         MongoDB                                  │
│  (Direct access from 46 places in integration code)             │
└─────────────────────────────────────────────────────────────────┘
```

**Problem:** Changing `protractor.ts` can affect `normalized-adapters.ts` which is shared with Tekmetric.

---

## Part 3: Proposed Modular Architecture (To-Be)

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Routes                               │
│  (Import from Integration Facade only)                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Integration Facade                            │
│  lib/integrations/index.ts                                       │
│  - Unified interface for all integrations                        │
│  - Auto-detects which SMS is configured                          │
│  - Routes calls to correct adapter                               │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  PROTRACTOR     │  │  TEKMETRIC      │  │  AUTOFLOW       │
│  MODULE         │  │  MODULE         │  │  MODULE         │
│                 │  │                 │  │                 │
│ lib/integrations│  │ lib/integrations│  │ lib/integrations│
│ /protractor/    │  │ /tekmetric/     │  │ /autoflow/      │
│                 │  │                 │  │                 │
│ ├─ client.ts    │  │ ├─ client.ts    │  │ ├─ client.ts    │
│ ├─ adapter.ts   │  │ ├─ adapter.ts   │  │ ├─ adapter.ts   │
│ ├─ transform.ts │  │ ├─ transform.ts │  │ ├─ transform.ts │
│ ├─ sync.ts      │  │ ├─ sync.ts      │  │ ├─ sync.ts      │
│ ├─ types.ts     │  │ ├─ types.ts     │  │ ├─ types.ts     │
│ └─ index.ts     │  │ └─ index.ts     │  │ └─ index.ts     │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Shared Core (Integration Agnostic)            │
│                                                                  │
│  lib/core/                                                       │
│  ├─ normalized-schema.ts  (Entity definitions)                   │
│  ├─ repository.ts         (Database abstraction)                 │
│  ├─ rate-limiter.ts       (Shared rate limiting)                 │
│  ├─ job-index.ts          (Shared job indexing)                  │
│  └─ types.ts              (Shared types)                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Data Access Layer                             │
│  lib/data/                                                       │
│  ├─ repositories/                                                │
│  │   ├─ shop-repository.ts                                       │
│  │   ├─ vehicle-repository.ts                                    │
│  │   └─ work-order-repository.ts                                 │
│  └─ mongo.ts (Single entry point)                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 4: Implementation Plan

### Phase 1: Foundation (1-2 days)
**Goal:** Create the modular structure without breaking existing code

| Task | Description | Files |
|------|-------------|-------|
| 1.1 | Create `lib/integrations/core/` directory structure | New directories |
| 1.2 | Create `IIntegrationAdapter` unified interface | `lib/integrations/core/types.ts` |
| 1.3 | Create `IntegrationFacade` class | `lib/integrations/core/facade.ts` |
| 1.4 | Create shared `RateLimiter` abstraction | `lib/integrations/core/rate-limiter.ts` |
| 1.5 | Create `Repository` base class for DB access | `lib/data/repository.ts` |

### Phase 2: Protractor Module (2-3 days)
**Goal:** Extract Protractor into self-contained module

| Task | Description | Files |
|------|-------------|-------|
| 2.1 | Create `lib/integrations/protractor/` directory | New directory |
| 2.2 | Extract API client to `client.ts` | Split from `protractor.ts` |
| 2.3 | Extract transformations to `transform.ts` | Split from `protractor.ts` |
| 2.4 | Create `ProtractorAdapter` implementing unified interface | `adapter.ts` |
| 2.5 | Move backfill to module | `sync.ts` |
| 2.6 | Create module index with clean exports | `index.ts` |
| 2.7 | Update API routes to use new module | Various routes |

### Phase 3: Tekmetric Module (2-3 days)
**Goal:** Extract Tekmetric into self-contained module

| Task | Description | Files |
|------|-------------|-------|
| 3.1 | Create `lib/integrations/tekmetric/` directory | New directory |
| 3.2 | Extract API client with OAuth | `client.ts` |
| 3.3 | Extract transformations | `transform.ts` |
| 3.4 | Create `TekmetricAdapter` implementing unified interface | `adapter.ts` |
| 3.5 | Move incremental sync to module | `sync.ts` |
| 3.6 | Create module index | `index.ts` |
| 3.7 | Update API routes | Various routes |

### Phase 4: AutoFlow Module (1 day)
**Goal:** Extract AutoFlow into self-contained module

| Task | Description | Files |
|------|-------------|-------|
| 4.1 | Create `lib/integrations/autoflow/` directory | New directory |
| 4.2 | Extract and modularize | `client.ts`, `adapter.ts`, `index.ts` |

### Phase 5: Cleanup & Testing (1-2 days)
**Goal:** Remove legacy code and add tests

| Task | Description | Files |
|------|-------------|-------|
| 5.1 | Remove old monolithic files | Delete deprecated files |
| 5.2 | Add unit tests per module | `tests/unit/integrations/` |
| 5.3 | Add integration tests with mocks | `tests/integration/` |
| 5.4 | Update documentation | `replit.md`, API docs |

---

## Part 5: Unified Interface Definition

```typescript
// lib/integrations/core/types.ts

export interface IIntegrationAdapter {
  provider: string;
  
  // Configuration
  isConfigured(shopId: number): Promise<boolean>;
  getConfig(shopId: number): Promise<IntegrationConfig | null>;
  testConnection(shopId: number): Promise<{ ok: boolean; error?: string }>;
  
  // Vehicles
  getVehicle(shopId: number, vehicleId: string): Promise<Result<NormalizedVehicle>>;
  getVehicleByVin(shopId: number, vin: string): Promise<Result<NormalizedVehicle>>;
  
  // Work Orders
  getWorkOrder(shopId: number, workOrderId: string): Promise<Result<NormalizedWorkOrder>>;
  getWorkOrders(shopId: number, options: WorkOrderQuery): Promise<Result<NormalizedWorkOrder[]>>;
  
  // Canned Jobs
  getCannedJobs(shopId: number): Promise<Result<CannedJob[]>>;
  
  // Sync
  runBackfill(shopId: number, options?: BackfillOptions): Promise<BackfillResult>;
  runIncrementalSync(shopId: number): Promise<SyncResult>;
}

export type Result<T> = 
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

export interface IntegrationConfig {
  provider: string;
  configured: boolean;
  credentials: Record<string, any>;
  metadata: Record<string, any>;
}
```

---

## Part 6: Quick Wins (Can Do Now)

These can be done immediately without full refactoring:

1. **Create integration index file** - Single import point
   ```typescript
   // lib/integrations/index.ts
   export * from './protractor';
   export * from './tekmetric';
   export * from './autoflow';
   export { getConfiguredAdapter } from './facade';
   ```

2. **Add JSDoc to existing functions** - Improves discoverability

3. **Create type-only exports** - Reduce circular dependencies

4. **Add integration-specific env validation** - Catch config errors early

---

## Part 7: Benefits After Refactoring

| Before | After |
|--------|-------|
| Change Protractor → risk breaking Tekmetric | Changes isolated to module |
| 2,671 line file to navigate | ~500 line focused files |
| Direct DB calls scattered | Repository pattern, easy to test |
| Different function signatures per integration | Unified interface |
| Hard to add new integration | Follow template, implement interface |
| No unit tests possible | Mock at module boundary |

---

## Appendix: File Inventory

### Current Integration Files to Refactor

| File | Lines | Action |
|------|-------|--------|
| `lib/integrations/protractor.ts` | 2,671 | Split into module |
| `lib/integrations/protractor-backfill.ts` | 501 | Move to protractor/sync.ts |
| `lib/tekmetric.ts` | 558 | Move to tekmetric/ |
| `lib/tekmetric-auth.ts` | 168 | Move to tekmetric/auth.ts |
| `lib/tekmetric-sync.ts` | 127 | Move to tekmetric/sync.ts |
| `lib/tekmetric-incremental-sync.ts` | 435 | Move to tekmetric/sync.ts |
| `lib/tekmetric-job-index.ts` | 384 | Move to tekmetric/job-index.ts |
| `lib/tekmetric-usage-tracker.ts` | 154 | Consolidate with api-usage-tracker |
| `lib/integrations/autoflow.ts` | 360 | Move to autoflow/ |
| `lib/normalized-adapters.ts` | 1,204 | Split per integration |
| `lib/normalized-ingestion.ts` | 1,330 | Split per integration |

### Files to Keep As-Is

| File | Lines | Reason |
|------|-------|--------|
| `lib/normalized-schema.ts` | 1,501 | Shared schema, well-designed |
| `lib/api-usage-tracker.ts` | 834 | Cross-cutting concern, appropriate |
| `lib/mongo.ts` | 61 | Core infrastructure |
| `lib/job-index.ts` | 553 | Will be used by all integrations |

---

## Next Steps

When you return, tell me which phase to implement:

1. **"Implement Phase 1"** - Create foundation/structure
2. **"Implement Phase 2"** - Modularize Protractor
3. **"Implement Phase 3"** - Modularize Tekmetric
4. **"Implement all phases"** - Full refactor (5-7 days)
5. **"Just do quick wins"** - Low-risk improvements only
