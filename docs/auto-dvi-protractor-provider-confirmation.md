# Protractor inspection safety: provider confirmation required

## Status — closed as skipped at user direction

Research checked on 2026-10-19. No authoritative affirmative or negative
confirmation of the required concurrency and upstream termination guarantees
has been obtained. The user chose to skip further confirmation and remove the
NO-GO designation. This is not a capability certification or approval to enable
enrollment. No further outreach or experiments are planned. This document is a support
request draft, **not a submitted ticket or a provider response**.

No provider writes, fixture changes, enrollment changes, fleet/relay changes,
or operator recovery/grant work were performed for this research.
`DURABLE_DVI_ENROLLMENTS` remains empty; no capability adapter is installed.

## Sources and limits

- Supplied *Protractor .Net Integration Web Service Development Guide*,
  10-10-2020, in
  `attached_assets/Protractor.Net_Integration_Web_Service_1764252528799_1778356873168.docx`.
  Its base URL is IntegrationServices/1.0; the project's API reference uses 2.0.
  Current version applicability therefore needs explicit provider confirmation.
  See `auto-dvi-protractor-pilot-evidence.md` for the section-level findings
  and the approved synthetic fixture manifest.
- https://integration.protractor.com/integrationservices/2.0/swagger/ui/index#/
  returned **401 Unauthorized / Invalid credentials** to the unauthenticated
  documentation fetch. This does not establish the absence of any API feature.
  That initial fetch supplied no credentials. Subsequently, the user provided
  the authenticated Swagger UI link through the secrets flow. Its loading page
  returned 200 and revealed the correct schema path below. No access controls
  were bypassed; no credential-bearing URL is retained in this document.
- https://protractorsoftware.com/software-support
  advertises live chat and in-product email/phone support. It does not describe
  revision, exclusive-edit, conditional-write, or cancellation guarantees.
- Public web searches for the automotive integration API's concurrency,
  inspection updates and timeout contract did not locate a usable authoritative
  contract. Angular Protractor and unrelated ETag documentation are not evidence.

## Current 2.0 Swagger inspected

The UI resolves its `/swagger/docs/v1` argument relative to
`/IntegrationServices/2.0`, **not** the host root. The resulting public schema
returned 200 without credentials:

https://integration.protractor.com/IntegrationServices/2.0/swagger/docs/v1

Schema metadata: title `Protractor Integration Web Service`, `info.version=v1`,
with the introduction explicitly naming the IntegrationServices/2.0 base URL.
The schema's `v1` label is not evidence that the service endpoint is version 1.0.
SHA-256 of the fetched schema response:
`30c8e4b0804654a67f163aff40c1dc42a135da0b7137a51799552723612e560b`.

| Required guarantee | Current Swagger evidence | Assessment |
| --- | --- | --- |
| Revision covering inspection and staff edits | `definitions.Header` exposes LastModifiedTime as a date-time string, without change-coverage or monotonicity semantics. No revision or ETag contract was found. | Still unknown; the pilot's unchanged timestamp remains disqualifying as a verified revision. |
| Conditional writes | Both POST operations list only the path ID and body parameters, with only a 200 response documented. No If-Match, stale-precondition rejection, or atomic comparison semantics are documented. | Not established; missing Swagger fields do not prove unsupported behavior. |
| Exclusive editing | POST `/WorkOrder/{id}` says: “Updating packages or lines via the API is not recommended while the work order is being edited.” No work-order lock acquisition/release or fencing contract appears in the schema. | Warning corroborated in current documentation; no exclusive-write guarantee established. |
| Upstream termination | No write cancellation, terminal request-status, disconnect or execution-deadline contract was found. Timeout mentions concern callback delivery and an email server setting, not work-order write termination. | Still unknown. |

POST `/WorkOrder/{id}/Inspection` explicitly describes ID-based package/inspection
line upserts, processing only Chapter=Inspection and ignoring service package
lines. That is an update contract, not a concurrency guarantee. POST
`/WorkOrder/{id}` also reiterates that package/line removal is unsupported.
Formatting/deletion implementation remains separate work.

Only documentation GETs were issued. No “Try it out” operations, customer-data
reads, synthetic writes, or timeout/contention experiments were executed.
The impossible If-Match/Note probe remains inconclusive. The current Swagger
does not resolve the support questions below. They are retained as unanswered
questions, not active follow-up work.

## Ready-to-send request to Protractor integration engineering

Subject: Written concurrency and termination contract for WorkOrder inspections

We need to prevent inspection updates from overwriting simultaneous staff edits
or arriving after a client timeout. Please provide current versioned documentation
or written engineering confirmation applicable to IntegrationServices/2.0,
specifically POST `/WorkOrder/{id}` and POST `/WorkOrder/{id}/Inspection`.
Please answer separately for both endpoints and identify any tenant settings
or API versions required.

1. **Revision coverage.** Which provider-issued revision or HTTP metadata changes
   on every relevant inspection package/line and work-order edit, including
   staff UI edits? Is it monotonic/non-reusable, including edit-and-revert?
   How is it obtained consistently with a complete exact-ID read? In our
   synthetic pilot, `Header.LastModifiedTime` did not advance with inspection
   updates, so we cannot use that timestamp as a revision.
2. **Atomic conditional updates.** Is a revision precondition supported?
   Please specify the exact header/body field, endpoint, comparison semantics,
   rejection status/body, and guarantee of no partial mutation on rejection.
   Are preconditions checked atomically at commit, including queued writes?
   Are unknown conditional headers ignored? Our impossible If-Match probe
   returned success but its Note sentinel did not persist; it is inconclusive,
   not evidence either for or against support.
3. **Exclusive editing alternative.** If conditional writes are unavailable,
   is there a supported provider-side exclusive lock covering both staff UI
   and API writers, including already-open staff edit sessions? Please specify
   acquisition, scope, ownership/fencing, renewal, expiry, release and crash
   semantics. Can a queued old write commit after lock expiry or transfer?
   A local integration lock or asking staff not to edit is not sufficient.
4. **Timeout/disconnect and delayed commits.** Can an admitted write continue
   after a client or relay disconnects or times out? Is there a request ID,
   status endpoint or cancellation acknowledgment proving that it has committed
   or can never commit later? Please document any execution/queue lifetime
   bounds and when they begin. A local timeout, socket close, or matching
   follow-up GET alone cannot prove upstream termination.
5. **Safe verification.** Please supply a minimal supported writable sentinel
   and request projection for testing stale-revision rejection or exclusive
   editing, plus a safe procedure to demonstrate terminal status after lost
   responses. Confirm how to verify no partial writes and no delayed commits.
   We will use only the previously approved synthetic records, not customer ROs.

Please include a documentation version/date, endpoint-specific examples and
explicit answers when a capability is unsupported or unknown. General statements
that updates are supported or requests time out are not enough to establish
these guarantees.

## Evidence needed to unblock

Capture the provider response with source, date, support reference and applicable
API version (without credentials or customer data). Map each answer to the five
questions above; unanswered items remain unknown. A newer supported mechanism
must be reconciled with the guide's concurrent-staff-edit warning.

Only after the contract is understood should a bounded verification plan be
prepared for the existing approved synthetic records. Establish ordinary
sentinel persistence before interpreting any stale-write test. Do not induce
ambiguous writes without an approved safe termination/recovery procedure.
Preserve the existing relay, fleet pacing, stop and authorization controls.

This research does not authorize additional execution or enrollment.
Normalization/deletion corrections and operator recovery/grants remain separate
work. Provider confirmation is necessary but is not itself adapter certification:
the approved fixture must still demonstrate the documented guarantees.
