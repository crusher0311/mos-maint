# Tekmetric DOT preservation and isolated recovery

## Scope and activation

These branch changes do not enable Tire DOT reporting, install indexes, seed
production data, or enroll any shop in provider enrichment. Neither design
artifact is modified.

Normal reporting requests, polling and exports continue to read stored results.
Provider enrichment, if separately enabled, occurs only in the existing
incremental background synchronization path.

`TEKMETRIC_TIRE_DOT_CAPTURE_SHOPS` is an explicit comma-separated MOS shop-ID
allowlist, empty by default. No environment value was set during development.
Enrollment must be separately reviewed, including current provider mappings,
report source indexes, canonical store mode and provider capacity.

## Capture policy

An enrolled background poll may request a detailed RO only when a candidate
tire part entirely omits `dotNumbers`. An explicit empty array does not trigger
another request. Provider shop, invoice, RO, vehicle and customer identities must
match, and the shop configuration is rechecked before and after the request.

Additional hydration is capped at five per process per minute and also uses the
existing shared Tekmetric rate limiter and background credential lane. The
per-process ceiling is not represented as a fleet-wide five-request limit.
Provider failures propagate to the existing sync error handling; no fabricated
empty DOT response is stored as a successful detail capture.

The current detailed response replaces the incoming list response as a whole.
This avoids combining old financial lines with different current part evidence.
Normal provider retry/deadline policy remains the existing client's policy;
the separate operator recovery below deliberately uses no automatic retries.

## Preservation policy

Mongo uses an atomic update pipeline; the PG repository uses a transaction with
a per-shop/RO advisory lock and row lock. They carry a prior DOT array only if:

- provider shop and RO match;
- current and previous job/part IDs each resolve uniquely;
- the part remains present with unchanged quantity;
- retained product identifiers and descriptors (part number, brand/model, size,
  name/description and load/speed/construction attributes) are unchanged;
- the incoming part omits the DOT property.

Incoming explicit arrays, including `[]`, are authoritative. Removed jobs/parts,
changed quantities, ambiguous identities or different shops/ROs do not inherit.
No financial values or absent jobs/parts are restored.

Carried entries are marked `_mosDotInherited`. The report displays an exception
and incomplete-coverage reason: retained evidence is not current confirmation.
Duplicate DOT strings and leading zeros are preserved.

This protects fields on identified current lines; it is not an archival version
store for wholly missing jobs collections or deleted lines. Retention/audit
history beyond the current cache remains separate work.

## Candidate detection and missing-field semantics

Structured passenger/light-truck tire dimensions can identify candidates even
when the part has no name. Conservative supported bounds are width 125–455,
aspect ratio 20–95, rim diameter 10–30. Known non-tire/service descriptions
(warranty, fluid, rotation, mount labor, etc.) still veto candidates.
This is not guaranteed coverage for every specialty tire.

Absent DOT properties now have a distinct exception and coverage warning.
An absent field does not establish that the shop recorded no DOTs.

## Isolated August recovery

The operator script resolves current HEART membership, uses the supplied August
Sales Details export, and discovers raw tire candidates through exact provider
identities from both the initial comparison and direct-raw fallback.

Safety controls:
- Local validation output only; no database writes or operational repairs.
- At most 1,000 candidate invoices; one sequential request after a 1.1-second
  delay, 15-second timeout, 3 MB response cap, and stop on provider/identity error.
- Existing unexpired credential only; no token refresh or persistent secret.
- Attempt markers precede requests; existing successful responses are reused.
  Uncertain attempts require an explicit reviewed single-ID retry argument,
  recorded in a distinct marker. There is no automatic replay.
- Live shop mapping and enterprise membership are checked before each request.
- Only reporting and monetary fields are retained in ignored, mode-0600 local
  files. Customer/contact payloads and notes are not retained.
- Candidate-based coverage remains incomplete: an unlocated raw invoice, absent
  tire metadata, specialty dimensions, conflicting copies or unrecognized status
  can prevent a complete population. CSV days are CDT; report days are UTC.

The dry run identified 974 candidate invoices. Actual completed recovery results
and errors must be reported from its checkpoints, not inferred from that plan.
Local files are under the August `detail-recovery` directory in
`generated-artifacts/heart-tire-dot-validation/`.

## Evidence limits

The known Northbrook detailed response and a subsequent vehicle-filtered list
response both contain DOTs today, with the same RO update timestamp as the
field-omitting September cache snapshot. A prior date-constrained diagnostic
list request returned HTTP 400. Do not claim list endpoints always omit DOTs or
that a specific historical writer has been proven responsible.

## Verification

Tests cover atomic Mongo preservation, real disposable PG adapter concurrency,
explicit clears, duplicated identities, removed lines, cross-shop isolation,
literal strings, optional hydration enrollment/budgets/identity changes,
structured tire candidates, and missing/retained evidence warnings.
All test stores are disposable local instances, not shared application stores.

## Recovery checkpoint: paused, not complete

On October 30, 2026 the recovery completed 365 of 974 candidate invoices.
The 609 remaining invoices must not be represented as checked.

The first run stopped after 242 completed invoices. Its original generic error
message did not retain the specific cause, so no cause is asserted. An explicitly
reviewed single-ID retry succeeded and continuation later stopped on a confirmed
HTTP 429 at the known Northbrook control invoice. No automatic retry followed.
The previously approved control reads remain separate evidence, not fabricated
complete recovery checkpoints.

Offline rendering of the completed checkpoints yields 261 eligible tire
invoices, 275 part lines, quantity 650, and eight DOT entries across two
Northbrook invoices. All 365 recovered invoices agree with all seven exported
monetary fields. These are partial results, not fleet-wide totals.

Evanston and Wilmette candidate recovery completed (204 and 153 respectively).
Northbrook has eight completed candidates. Other locations have no completed
recovery requests yet. Missing vehicle context in the minimized recovery
payloads remains explicit; do not fill it using current vehicle mileage.

The branch changes passed 24 automated checks, including browser flow, real
Mongo and real PG preservation/concurrency checks, plus TypeScript checking.
The isolated fixture preview loaded. The authenticated production UI was not
verified and no live feature/capture enrollment was enabled.

The per-request delay did not reserve shared provider capacity: concurrent
normal sync can still exhaust the tenant limit. Before continuing, choose a
reviewed quiet window or a coordinated shared-budget recovery path. Do not
silently remove attempt markers or retry the paused invoice.

## Approved coordinated continuation

The user approved using shared rate limiting and normal operational
request/authentication bookkeeping. Continuation uses the same active Mongo
`tek:` bucket as normal primary-credential traffic, at background priority.
Before starting, existing live bucket activity and the TTL index were verified.

The operator wrapper permits only rate-bucket counter operations; its index
hook validates the existing TTL index and does not create or modify an index.
It rejects disabled coordination, backend mismatch, fallback/fail-open grants
and timed-out grants. Saturation waits for up to two minutes before stopping
without sending a provider request. Provider HTTP failures still stop the run.

The paused HTTP-429 invoice receives one explicitly reviewed retry marker;
all successful local checkpoints are reused. Invoice data remains local.
Use actual final checkpoints to replace the earlier partial counts; starting a
coordinated continuation is not itself proof of successful completion.

### Coordinated continuation outcome

The approved shared-budget run advanced from 365 to **543 of 974** completed
candidate invoices, then stopped on another provider HTTP 429. **431 remain**.
There was no automatic retry and no bypass of shared coordination.

The updated offline report contains **385 eligible tire invoices**, 407 part
lines, quantity 1,001, and **176 DOT entries across 48 invoices**:

- Northbrook: 56 DOT entries across 14 included invoices; all 132 candidates read.
- Libertyville: 120 DOT entries across 34 included invoices; 54 of 188 candidates read.
- Evanston and Wilmette: candidate reads complete; no nonempty arrays found in
  the retrieved candidate detail responses.
- Other five locations: no completed recovery requests yet.

All 543 recovered invoices match the export's seven monetary fields. These
counts supersede the earlier 365-invoice checkpoint, not its audit record.
The original known Northbrook invoice is now included in a full recovered
checkpoint. Its repeated DOT entries remain separate.

Verified bucket activity does not guarantee every other caller uses the bucket,
nor prove which provider limit caused a 429. Do not claim the second rate limit
is understood. Recovery and live readiness remain incomplete; resume the 431
remaining candidates only in a reviewed quieter window or after investigating
the provider's effective capacity. Preserve the failed-attempt marker and reuse
all successful checkpoints.
