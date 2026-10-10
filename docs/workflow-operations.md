# Shop operations controls

Managers can opt a shop into readiness gates from the Operations tab. This is
off by default, independent of scheduling enablement. Deploying code does not
turn on gates at any shop. All writes use existing shop/session permissions,
revision checks, idempotent request receipts and audit logging.

## Included
- Manager-reviewed parts and diagnostic readiness, explicitly required skills,
  and add/edit/remove/resolve actions for owned blockers.
- Assigned technicians and managers can record/acknowledge handoffs and sign off
  or reopen configured final checks. Checks cannot be signed off before work
  starts. Changing a check's label clears its old signoff. Closed visits are
  read-only; completed readiness and handoff notes cannot be rewritten.
- With gates enabled, unreviewed or blocked work cannot start. Changing an
  existing owner requires a fresh handoff; the recipient or manager acknowledges
  before restarting. Readiness and required final checks gate completion, and
  outstanding final checks prevent closing a visit.
- Repair-before-alignment suggestions use narrow title patterns, not an
  authoritative repair procedure. Managers confirm each dependency. Inspection
  wording alone does not suggest a repair dependency. Existing manual dependency
  selection remains available, including removal. Cycles are rejected.
- Saving a plan checks dependent starts against known prerequisite duration and
  start; moving an earlier job cannot silently invalidate downstream plans.
- Promise warnings calculate a dependency-only lower bound from remaining labor,
  planned starts and dependencies. Unknown durations, readiness, unassigned work,
  overruns and final checks are called out. This is not a resource-optimized ETA
  and must not be presented to customers as a guaranteed completion time.
- Next-job recommendations use explicit readiness, dependency completion,
  confirmed required skills, waiting-customer status and promise ordering. They
  require configured scheduling, fresh complete appointment evidence and enough
  shift/lane capacity. A missing skill requirement does not prove qualification.
  Recommendations never assign, start or move jobs automatically.

## Boundaries
Parts readiness is manual. A generic Protractor line Status, listed part or
callback does not establish delivery or partial receipt. Automatic ingestion
awaits the separately requested provider-evidence investigation.

No automatic provider writes, customer notifications, live credential creation,
shop enablement or database migration. Existing source refreshes preserve local
operations data. Shop settings, book labor, actual work time and customer arrival
remain distinct concepts.

Verification uses synthetic offline tests and browser fixtures only. The shared
development Mongo database is production and is not safe for test writes.
