---
name: Demand-driven reporting compatibility
description: Product compatibility rules when moving reporting from synchronous dashboards to durable cached runs.
---

Demand-driven reporting is not only a query-execution change. Preserve immutable saved-version behavior, pinned delivery links, management of existing schedules (including legacy ones), and the full recipient scope identity used during delivery reauthorization.

**Why:** These surfaces are easy to strand when replacing a dashboard-first page or synthesizing background-worker sessions. The report can be technically cached and authorized while still showing the wrong saved version, leaking old run state across selections, or making existing deliveries impossible to manage.

**How to apply:** Any reporting lifecycle change should test opening a pinned delivery URL, switching definitions during an active run, editing then saving/running a saved version, managing a pre-existing schedule, and validating enterprise recipient scope before delivery.

Incomplete data with explicit coverage is an accepted product outcome for invoice-hour reporting; it is not permission to repair history or contact providers.

**Why:** Verified invoice populations differ from terminal work-order counts; existing imports and fallback close dates cannot justify silently treating missing invoice or hour evidence as zero.

**How to apply:** Preserve that availability boundary when improving reporting. Extending source support or repairing history requires separate scope; do not repurpose the legacy closed-RO measures as invoice averages.

Reporting filters must be available independently of report execution.

**Why:** A platform-wide invoice report exceeded the bounded scan, but location
choices depended on that same report succeeding. Users could not narrow the
query to recover, and generic failure sanitization hid the actionable limit.

**How to apply:** Load authorized scope metadata without querying history. Keep
bounded-query failures distinct from SQL faults, with safe recovery guidance.
Do not remove query bounds or filter by fallback close dates to disguise an
invoice-evidence population problem.

An invoice date-range optimization must retain other representations of the same
candidate identities, even outside the requested dates.

**Why:** Dropping an out-of-range conflicting date can turn an uncertain invoice
into a falsely complete denominator. Unknown copies may also be resolved by a
verified copy outside the period.

**How to apply:** Test conflicting dates and missing-evidence copies across the
date boundary; keep unknown-population work explicit and bounded. Treat matching
partial indexes as an operator-approved rollout, not an assumed production fact.

Keep full current authorization separate from effective execution locations.

**Why:** A definition may explicitly select two shops and then filter to one.
Recompiling that definition against the one-shop execution scope incorrectly
rejects the other selected shop. Historical runs can also have a broader stored
authorization set than their displayed location rows.

**How to apply:** Revalidate definitions against full current authorization;
use the effective intersection for queries and new cache identities. Reject
empty intersections before queueing, and authorize historical reads against
their stored scope without demanding equality with the new query subset.

Reporting fixes prompted by JWT are fleet-wide, not JWT-only rollouts.

**Why:** The user explicitly clarified that JWT exposed a shared reporting issue,
not a customer-specific feature request.

**How to apply:** Apply shared reporting corrections to all eligible shops and
enterprises, preserving authorization boundaries and provider evidence requirements.

Verified invoice evidence must survive both initial normalization and later
partial provider snapshots.

**Why:** A read-only production comparison found usable invoice evidence in
archived Protractor Invoice responses while the corresponding stored work orders
had none. Newly created rows discarded mapped custom fields; older snapshots
often lacked a positive invoice number despite richer archived copies.

**How to apply:** Test evidence persistence through the real create path, not
only the adapter. Distinguish legacy missing evidence from legitimate unknowns.
Any repair must verify shop/invoice identity and reconcile conflicting evidence;
patch reporting metadata only, never financial totals or provider invoices.

Keep reporting changes local until the reporting flow is working and verified,
not merely until a release build passes.

**Why:** The user explicitly rejected another reporting deployment before
verification after successive releases still left the report unusable.

**How to apply:** Verify scope, stored evidence, calculations, and visible
results together. Clearly separate fixture success from real-data coverage;
missing presented-hour evidence is not cured by passing SQL or browser tests.

Protractor's omitted deferred-work collection can mean no deferred jobs on a
verified final invoice; do not extend this to incomplete or open work orders.

**Why:** A bounded live comparison on 2026-10-17 found five omitted-field
invoices also omitted the collection in detail responses, while five
known-deferred controls retained identical jobs and hours. The user then checked
two omitted-field examples in the native UI and confirmed neither had deferred
or declined work. This confirms omission-as-empty for the verified invoice shape.

**How to apply:** See docs/invoice-evidence-preservation-preview.md for the
evidence and limitations. Require valid invoice identity/date/finality and regular
job collections. Explicit null/malformed deferred fields, missing labor hours,
and unknown dispositions remain incomplete; do not manufacture zero hours.

Validate proposed reporting-metadata repairs against a disposable local copy
before asking to deploy or apply them.

**Why:** The user explicitly requested the real ten-shop full-period report,
not another passing sample followed by a production release that remains unusable.

**How to apply:** Keep external stores read-only, run the actual bounded report
SQL before/after the local repair, and report unresolved populations honestly.
Do not treat exit success or candidate counts as report correctness. Production
metadata writes and deployment still require separate approval.

Long stored-evidence validation must preserve resumable local snapshots on
timeout and keep the original reporting baseline separate from local repairs.

**Why:** The expanded read-only reconciliation exceeded its initial wall-clock
limit after nine shops; deleting the temporary database forced production
source reads to be repeated. A resumed repaired baseline would also falsely
improve the "before" result.

**How to apply:** Retain only private, minimal reporting evidence locally on
failure; validate completed-shop checkpoints, keep source query limits intact,
and restore the original baseline when repeating report comparisons.

Invoice-source recovery is a separate, capped read-only operation, not authority
to publish reporting changes or repair production reporting records.

Exhaust stored invoice evidence before requesting additional source recovery.

**Why:** The user explicitly chose stored-data-first verification after seeing
that raw invoices were available but underused by reporting. Unknown report
population is not proof that upstream requests are necessary.

**How to apply:** Match shop-scoped provider identities across stored payloads
and verified archives, preserve conflicts, and establish specific missing fields
before proposing new requests. Do not automatically resume an operator-paused
evidence recovery or confuse it with the separately authorized weekend backfill.

Classifying stored uninvoiced work is not proof of the provider's current state.

**Why:** The user approved local classification to resolve reporting's unknown
population, not dropping ambiguous records or assuming an old open-work snapshot
means the work was never invoiced later.

**How to apply:** Require explicit source-stage and zero-number evidence across
matched copies, retain invoice/date/identity contradictions, and report coverage
as stored-evidence coverage. Keep production status changes and deployment
outside the local classification experiment.

Zero-number Protractor snapshots can represent the same invoice as independently
captured positive-number Invoice responses; credit slips are a separate document
class, not ordinary invoices.

**Why:** A stored-data audit on 2026-10-18 found matching invoice IDs and dates
between zero-number normalized snapshots and positive-number source captures.
It also identified CreditSlip payloads among documents rejected by invoice
verification. This does not establish eligibility for every zero-number record.

**How to apply:** Prefer corroborated source evidence over rejecting a record
solely for a zero number. Keep date/hour/identity conflict checks, distinguish
credit documents, and never call corroborated matches newly recovered invoices
without rerunning the actual report. Header-only audits do not verify labor.

Sample unresolved reporting records from the actual report candidates, not all
historical rows carrying the same diagnostic reason.

**Why:** Known open work shares the missing-number diagnostic but is already
excluded by report SQL. A candidate-filtered trace instead found historical
InvoiceTime values behind the unknown-period population.

**How to apply:** Preserve the real query's status, deletion and date semantics
when investigating its gaps. Use actual InvoiceTime only for local date-scope
experiments; keep inconsistent copies and unknown peer dates unresolved.

Date-scope certainty and complete invoice evidence are separate questions.

**Why:** A local full-fleet comparison showed that many unknown-population
records had consistent actual invoice dates outside the reporting period.
Excluding those from that period did not require inventing invoice numbers or
hours, and did not change verified invoice totals.

**How to apply:** Treat date-only exclusion as a separate, explicitly validated
policy. Require agreement across matched copies and identity peers; never use
it to make in-period unknown records verified or suppress contradictory dates.

A labor-only conflict can retain its financial veto without blocking a period
that its independently verified invoice date excludes.

**Why:** Older drafts with fewer jobs were keeping early-September invoices in
a report beginning September 18, despite agreeing final invoice dates.

**How to apply:** Require all-copy date/identity review and peer checks. Keep
in-period, boundary, unknown-date and identity conflicts held. Exclusion must
never synthesize invoice evidence or select a supposedly correct labor version.

An omitted regular-job collection is not covered by the confirmed
omitted-deferred-work behavior.

**Why:** A final invoice capture held five deferred labor hours but no regular
ServicePackages collection. That establishes deferred work, not zero sold work.

**How to apply:** Keep that invoice's complete labor measures unavailable until
regular-work completeness is supported; do not generalize omission-as-empty
from the separately verified deferred collection.

Use provider modification times, not cache maintenance times, when comparing
historical Protractor work-order and invoice snapshots.

**Why:** A targeted stored-copy trace found earlier nonfinal snapshots retained
alongside later invoice-stage copies, while local updatedAt could be later than
the invoice itself. Local refresh chronology can reverse business chronology.

**How to apply:** Require matching identities and valid provider timestamps.
Never silently discard equal/newer nonfinal snapshots or conflicting final
copies. Chronology-based date exclusions still require separate local validation;
they do not establish invoice-number or labor completeness.

Source identity-set membership is not proof that two provider invoices are
versions of the same invoice.

**Why:** Targeted stored-data review found conflicting copies with two distinct
provider IDs, both present in the selected normalized row's provenance. Treating
these as older and newer versions could combine unrelated invoice labor.

**How to apply:** Verify equivalence before resolving conflicts by chronology.
Preserve identity vetoes even when both IDs match a row's lookup set. Also test
source projections end to end: dropping provider Header timestamps can make
valid chronology fail despite correctly timestamped raw data in storage.

Distinguish earlier sentinel-date snapshots from disagreements between two
final invoice versions.

**Why:** Stored-source tracing found earlier nonfinal copies with year-0001
invoice dates blocking otherwise agreeing final dates, but also found final
copies with genuinely different invoice dates and labor values.

**How to apply:** A chronology exception must verify same identity, source
ordering and nonfinal state. It must not become a general latest-copy-wins rule
for conflicting final invoices or financial values.

A date-only exception must not silently bypass labor comparisons.

**Why:** The legacy labor extractor rejects nonfinal stages before reading their
lines. Once an old sentinel date stops vetoing a snapshot, retaining that call
alone makes recorded-hour disagreement invisible.

**How to apply:** Test a strictly older nonfinal snapshot with different recorded
hours. Keep it unresolved rather than treating null from a finality-gated helper
as proof of financial agreement. Never use an old snapshot to invent new invoice
hours or establish finality.

Different totals on a pre-invoice draft and a final invoice are not necessarily
contradictory labor evidence.

**Why:** A targeted trace found older drafts with fewer jobs, while shared labor
line IDs retained the same hours in the final invoice. Separate final-version
conflicts did change hours on identical labor line IDs, so the two cases need
different treatment.

**How to apply:** Compare line identities and source stages before diagnosing
corruption or proposing latest-version selection. Where all verified dates are
outside the report period, evaluate date-only scope independently; do not weaken
financial conflict checks or claim a lower unknown count before validation.

Retained preview databases under `/tmp` are not durable across workspace sessions.

**Why:** A previously retained reporting database was absent on a later turn,
despite an earlier successful inspection. Reusing its path cannot establish that
the old snapshot still exists.

**How to apply:** Verify the directory and disposable marker before resuming.
If missing, rebuild a read-only preview and compare policies within that same
run; never attribute changed source totals between runs to a reporting fix.

Retained local reporting databases can exhaust workspace disk quota even when
`df` shows ample filesystem space.

**Why:** A local baseline query failed with XX000, then PostgreSQL recovery could
not start; creating its log exposed “Disk quota exceeded.” Several obsolete
disposable snapshots together consumed gigabytes. Removing only old generated
snapshots allowed the completed ten-shop checkpoint to resume.

**How to apply:** Inspect quota errors and sizes before repeating source reads.
Keep the latest verified baseline and active checkpoint; verify old databases
are stopped before deleting obsolete generated copies. A recovery interruption
does not authorize production changes or a fresh provider import.

**Why:** On 2026-10-17 the user approved up to 1,000 additional Protractor requests,
including retries, under existing eligibility and traffic protections, followed
by another local report validation.

**How to apply:** Preserve the cumulative cap and callback priority; never borrow
the active weekend runner's permission or use interactive authority for bulk
recovery. Missing or conflicting source dates remain held, not guessed. Source
captures may be retained for validation, but production repair and deployment
still require separate approval.