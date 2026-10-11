# Workflow calendar and scheduler API

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
  Once all work for an appointment has explicit local plans, those jobs reserve
  capacity rather than counting the same arrival twice.
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
