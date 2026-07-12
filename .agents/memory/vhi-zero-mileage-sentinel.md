---
name: VHI zero mileage anchors
description: dueMileage/dueAtMiles 0 is a legacy sentinel meaning "no mileage math", never a real odometer — writers persist null, readers must normalize >0-or-null.
---

The rule: a due-at odometer of 0 is never real. Time-only OEM rules (e.g. brake fluid: 36 months, no mileage interval) and DVI-finding rows have NO mileage math — persist `dueMileage`/`milesToGo` as `null`, and any reader converting cached recs must normalize (`dueMileage > 0 ? dueMileage : null`, and only trust `milesToGo` when a real anchor exists).

**Why:** the extension plan route used to serialize `dueMileage: 0`; that flowed into `maintenance_analysis_cache` and partner readers turned it into `dueAtMiles: 0`, where "remaining = 0 - currentMiles" reported the vehicle's ENTIRE odometer as overdue miles ("111,961 mi over" on brake fluid). Thousands of cached analysis docs carried the sentinel long after the writer was fixed — fixing writers alone doesn't fix caches.

**How to apply:** when adding any new writer or reader of plan/analysis recommendation mileage fields, treat 0 as absent. Cached docs predating a writer fix need a one-shot cleanup (`scripts/fix-zero-due-at-miles.ts`, dry-run default, prod Mongo → operator-gated). Render guard precedent: `lib/vhi-progress.ts` requires `dueAtMiles > 0`. Regression test: `tests/plan-build-task-479.smoke.ts`.
