# Workflow calendar and scheduler API

## Workflow check-in and official tickets

Manager-only `GET/POST /api/shop-dispatch/intake` uses the verified dashboard
session, current-shop workflow entitlement and same-origin JSON protections.
It is not exposed to integrator API keys or other providers.

- GET `?q=...` searches customers; `?contactId=UUID` lists that customer's
  vehicles. Selection is explicit and ownership is rechecked before writes.
  GET `?roNumber=...` previews a verified eligible open ticket. Linking requires
  its reviewed GUID as well as the human RO number; the server rechecks both.
- POST `checkIn` accepts a stable request UUID, board revision, nullable
  appointment ID and intake details. Appointment check-in requires fresh,
  complete shop-scoped arrival evidence. Walk-ins can record explicitly
  unresolved identity without creating provider records. Concerns become
  unauthorized local jobs, not repair authorization.
- Intake separates needed-by request, staff/customer-confirmed promise, next
  update, arrival, mileage and waiting/drop-off. `update` preserves local jobs
  and plans; edit jobs separately after check-in. Once ticket creation starts,
  identity/concerns are frozen, while customer commitments remain editable.
- `link` merges only a verified open Protractor identity into the selected
  workflow visit. Imported job IDs, time, readiness, dependencies and audit are
  retained. Conflicting local commitments or worked duplicate packages stop
  for explicit resolution rather than discarding history.
- `create` requires an explicit confirmation and confirmed existing or new
  customer/vehicle identity. It first commits immutable, payload-bound intent.
  Each customer, vehicle and RO stage is admitted by a separate board CAS,
  followed by provider I/O outside that local transaction. Upstream IDs are
  server-derived per shop and visit; a new browser request cannot allocate a
  second ticket for the same visit.
- `reconcile` reads exact saved IDs, confirms customer/vehicle ownership and
  the full expected concern-package set, continues only unattempted stages,
  and retries local finalization. An attempted but unverified stage is **not
  automatically sent again**: a timeout does not cancel provider work. If
  records/packages never appear, staff must investigate/complete the saved
  identities upstream, then retry verification. No new ticket button is
  offered for that pending visit. Pending and uncertain states are durable,
  visible to other managers, and cannot be closed as completed.

Only exact upstream verification plus local finalization produces a confirmed
ticket. Optional cached source refresh never creates a second visit for pending
intent. Concern packages are intake descriptions, not priced/authorized repair
packages. Existing manual jobs/plans stay attached when a ticket is created.

The browser retains shop-scoped drafts and exact unconfirmed requests in session
storage across reload. Successful walk-in requests retain their returned visit
identity; starting another walk-in is explicit.

Per-job offers rank qualified technician windows by earliest start, with
readiness, duration, dependency, shift, time-off, equipment, holds and appointment
checks. Unknown/unplanned backlog prevents a supported capacity offer. Historical
experience never supplies a qualification. Offers do not automatically assign,
reserve or promise whole-visit completion. Staff review the existing plan form;
normal server-side planning validation applies on save. Flexible drop-off and
customer-update discussions remain available without claiming same-day service.

## Vehicle history from workflow cards

Opening a workflow visit or scheduled job provides an on-demand, read-only history
panel without leaving the board. It uses
`GET /api/shop-dispatch/vehicle-history?visitId=...` under the authenticated
dashboard session and workflow/maintenance entitlements. Clients cannot choose
another shop or supply the vehicle VIN: the server resolves it from that shop's
cached provider order, rejecting missing or conflicting VIN identities.

Current-location service history is available independently of enterprise
sharing. Authorized sibling records use the existing enterprise history policy,
membership, account assignments, stage and entitlements. Onboarding additional
stores does not itself grant sharing access. Sources and coverage limitations
are displayed; empty or timed-out reads are not proof of no prior work.
Normalized records include human-facing RO numbers when available.

History reads never fetch Protractor live, write to the board, or invalidate
schedule drafts. Identity is rechecked before returning. The endpoint has a
shared read deadline, and workflow-specific cache lookups have database timeouts.
Current Auto DVI findings are snapshots, not a complete historical log. Visit-based
and shared DVI remain subject to their existing release gate and permissions.

This addition is opt-in per shop, behind the existing `shop_workflow` entitlement.
Managers configure Schedule → Settings: IANA timezone, weekly shop hours,
explicit technician shifts, time off, optional bay shifts/time off, buffer and
lead time. Unconfigured technicians have no advertised availability.
Settings do not alter provider appointments or employee records.

## Manager timeline

The default Day view has technician lanes and a searchable individual-job queue.
Drag jobs to another time/technician or resize their planned duration. Valid,
authorized routine moves save on drop; uncertain experience or missing planning
information opens a review drawer. Keyboard/touch users can set the same placement
in that drawer. The seven-day overview remains available. The work queue groups
jobs by vehicle and readiness; notes are retained separately rather than discarded.

Imported book durations round UP to quarter-hour planning proposals. Billed
labor remains unchanged. Existing saved estimates are preserved during moves.
Closed days are identified explicitly and link to the next configured working day.

An advisory warning appears for a new technician assignment with fewer than three
exact-match recorded completions without shared attribution. Unknown, failed or
incomplete history is disclosed; it does not prove inexperience. Manager
qualification checks remain separate and cannot be bypassed by acknowledging this
warning. Historical shared work is not treated as independent experience.

Undo reverses only the manager's immediate confirmed scheduling-only change,
within five minutes and at the same board revision. The server stores the
previous placement in a short-lived receipt; clients cannot supply restoration
values. Any newer board edit invalidates Undo. Idle work, current qualification,
hours, dependencies and capacity constraints are rechecked. Authorization,
billing and provider data are not reverted. This narrow immediate rollback does
not waive handoff requirements for normal reassignment.

Block widths use explicit planned minutes, otherwise known book minutes labeled
**book baseline — review**. Saving confirms a planned estimate without changing
billed labor. Truly unknown duration requires manual input. Provider appointment
arrivals remain read-only and distinct from local work blocks.

Placement uses the same hours, time-off, capacity-hold and dependency validation
as the server. Required skills must be manager-confirmed when operations are
enabled; moving an existing assignment preserves the handoff requirement.
Closed/completed/active or upstream-removed work cannot be dragged.

Network/5xx uncertainty retains the exact request for retry and locks other
schedule writes and internal workspace navigation. A revision rejection
requires refresh and explicit draft review. No optimistic movement is presented
as a saved plan. Leaving the page during an unresolved request raises a browser
warning; this is not durable draft storage.

## Scope and authentication

Use a **shop-scoped MOS API key**, sent as `Authorization: Bearer …` or
`X-API-Key`. Grant `workflow:availability` for availability and
`workflow:holds` for creating, inspecting and releasing holds. The existing
API-key rate limiter applies. Keys resolve the shop server-side; global partner
keys and request-supplied shop IDs are rejected. Provisioning real credentials
is a separate authorized operation.

### Availability

`GET /api/external/workflow/availability`

Query:
- `startDate=2026-10-12`
- `endDate=2026-10-13` (exclusive; maximum seven days per request)
- `durationMinutes=60` (15–480)
- optional `technicianId`, `resourceId`, `skillKey`

Results contain `timeZone`, board `revision`, `generatedAt`,
`appointmentFetchedAt`, `available`, `reasons`, `warnings`, `slots`, `truncated`.
Each slot has offset-qualified `start`, `end`, `technicianId`, `resourceId`.
Results are capped at 1,000; narrow the range or technician if truncated.
No customer, vehicle, RO, API-key identity or other scheduler's hold is exposed.
Availability is a snapshot, not a reservation. A slot can disappear before POST.

### Create a temporary reservation

`POST /api/external/workflow/holds` with JSON:

```json
{
  "requestId": "7fc0d51e-d566-49ed-963f-a58fe2f4a47d",
  "start": "2026-10-12T14:00:00Z",
  "end": "2026-10-12T15:00:00Z",
  "technicianId": "local-roster-id",
  "resourceId": "optional-bay-id",
  "skillKey": "optional-confirmed-skill"
}
```

Omit optional resource/skill or send null. Holds last **five minutes** and cannot
be silently extended. Retry an uncertain POST with the **same requestId and
identical body**. Different payload with the same ID returns 409; an expired or
released request returns 410. Request identities are retained for at least
24 hours. Response is `{hold, reservedIn:"MOS", providerAppointmentCreated:false}`.

`GET /api/external/workflow/holds?holdId=UUID` returns the owning key's hold and
an `active` flag. `DELETE` to the same path with JSON `{"holdId":"UUID"}` releases
it idempotently. A different key cannot inspect or release the hold. Managers
can see timing/lane information and explicitly release holds in the calendar.
Holds block immediately under the same revision compare-and-swap as local plans.
No TTL index or background worker is necessary: expiry is checked at every read/write.

## Capacity and safety

- Date navigation and availability use the configured shop timezone. Explicit
  offset instants distinguish repeated DST times. Ambiguous or nonexistent
  provider wall times remain unknown rather than guessed.
- Capacity includes all local jobs, not merely statuses visible on Dispatch,
  technician time off, shared bays, appointments and active holds.
- Manual planned duration takes precedence over imported book duration.
  Actual/paused work blocks its lane because its finish is unknown.
- Unscheduled backlog is shown and warned about but is not a timed reservation.
  Assign that backlog before relying on advertised capacity.
- Only manager-confirmed skills satisfy `skillKey`; historical experience alone
  does not qualify a technician.
- Unassigned/unmatched appointments conservatively reserve all technician lanes
  during their interval. Missing duration blocks that local day; missing start
  closes advertised capacity until resolved.
- Appointment arrival times are displayed separately from job work plans.
  Only an explicit appointment-to-visit link and a verified official ticket with
  every retained job planned can replace the arrival reservation. Incidental
  appointment/WO ID equality or RO-number matches never imply association.
  Partial plans and check-in alone leave the appointment reservation intact.
  A job can be planned within its own explicitly linked arrival window. This
  self-planning exception does not remove the reservation for other visits.
- Protractor reads are bounded, paginated and cached for at most five minutes.
  New hold attempts request fresh coverage. Failed, truncated, malformed or stale
  coverage yields no slots. Calendar data may remain visible with a warning.
- MOS can serialize MOS holds and local plans; it **cannot lock Protractor or
  another independent scheduler**. External provider edits after a read can
  invalidate availability. No cross-system atomic booking guarantee is made.

This API does **not** confirm bookings, convert a hold into an appointment, or
write back to Protractor. The existing external appointment-creation endpoint
does not consume these holds. Do not chain it as if doing so were atomic.
Booking confirmation/write-back requires a separately designed integration.

## Operations and verification

No database migration is required; settings, cached arrivals and holds extend
the existing single-document workflow store. Existing shops remain disabled
until a manager explicitly configures and enables scheduling. No live shop was
enabled, API key created, provider appointment changed or production DB mutated
as part of development.

Offline coverage:
`tsx --test --test-force-exit tests/shop-dispatch*.test.ts`
and `node --test components/shop-dispatch/*test.cjs`.
Checks cover capacity, CAS races, idempotency, expiry, tenant/permission gates,
incomplete provider responses, DST, manager forms and UI navigation.
