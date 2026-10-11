---
name: Shop workflow prototype scope
description: Product model and isolation boundary for Detect Dog scheduling exploration.
---

The scheduling concept is a vehicle visit containing individual jobs and multi-technician handoffs, not one appointment block per vehicle.

Integrator scheduling is authorized for availability and temporary MOS holds, not appointment confirmation or Protractor write-back.

**Why:** The user selected temporary reservations to prevent competing integrators taking the same MOS slot, with provider writes explicitly kept separate.

**How to apply:** Keep shop-scoped authorization and shared capacity checks. Do not present a MOS hold as a confirmed provider booking or route existing appointment-creation calls through it without a separately approved confirmation contract.

Operational additions prioritize readiness/owned blockers, manager-confirmed dependencies, promise-risk warnings, advisory next-job recommendations and handoff/final checks. Parts arrival automation is deferred pending Protractor evidence.

**Why:** The user requested beginning the operational improvements but explicitly saved the parts-callback investigation for later. Generic line status and listed parts do not prove receipt.

**How to apply:** Keep parts readiness manual until before/after receipt evidence establishes partial-delivery semantics and callback behavior. Recommendations must not silently reassign work or replace shop-approved repair procedures.

User-confirmed ordering and receipt can generate WorkOrder updates without changing the returned RO material line.

**Why:** On 2026-10-11, read-only before/order/receipt observations showed identical non-personal part fields and line modification time despite new callbacks. The blank line already carried `CoreStatus=Returned`, so that value does not establish delivery.

**How to apply:** Do not equate callback arrival with parts readiness. Verify a separate receipt/allocated-quantity contract and partial deliveries before enabling automation; the current evidence is documented in `docs/protractor-parts-receipt-investigation.md`.

Automatically refresh the job's parts list, but retain manual receipt readiness and require a fresh readiness review when a new part is added to an already-ready job.

**Why:** The user explicitly accepted this narrower behavior after the live addition/order/receipt comparison could not distinguish receipt status.

**How to apply:** Reconcile part identity, quantity, description and price from provider snapshots without labeling parts ordered or received. Do not silently preserve ready status for newly added parts.

Technician skill profiles must distinguish history-supported experience from manager-confirmed independent capability.

**Why:** The user wants capabilities derived from previously performed work, with manager confirmation and corrections; multi-technician work is not proof of independent proficiency.

**How to apply:** Attribute by employee identity on labor lines, retain shared-job caveats and invoice evidence, and keep manual assessments separate from history. Do not infer related skills from vague title similarity.

Protractor's archived Invoice results can retain `Type=WorkOrder` and `Completed=false` even for invoiced work.

**Why:** Read-only Burnett archive verification found this combination on its dated invoice history; treating the workflow checkbox as invoice completion would suppress all evidence.

**How to apply:** Use invoice-endpoint provenance and a real invoice timestamp as historical evidence, exclude credits, and describe it as invoiced work rather than verified task clock completion.

Workflow visibility must be configurable by upstream provider stage, independently of dashboard preferences. Advisors search and import by the human RO number, never a required provider UUID.

Technician roster identity is independent of MOS login access. Shops need to schedule technicians before accounts exist, and managers need named bay/equipment lanes.

**Why:** The user confirmed that the shop's technicians do not yet have MOS logins and explicitly requested additional lanes/bays.

**How to apply:** Permit name-only roster entries, link logins later without changing technician identity, and review provider staff before adding or matching lanes. Never create placeholder emails or infer account access from provider employment.

**Why:** The user explicitly wants dashboard-like stage selection on the workflow board and RO-number intake. Provider-stage visibility is not technician job progress.

**How to apply:** Use callback-cached orders for automatic intake, preserve local assignments and inspections when stages change, and retain access to hidden assigned work. Do not turn board refreshes into upstream polling.

**Why:** The user wants to evaluate the workflow experience before committing to a production scheduling system.

**How to apply:** Preserve separate arrival, work, and promise times and distinguish book labor, illustrative predicted technician time, active time, and waiting time.

Keep the presentation artifact fictional and frontend-only. The user separately authorized a one-location production pilot, assuming API access will be available.

**Why:** The original prototype scope excluded live services; the user subsequently explicitly chose the production pilot when asked to distinguish it from extending the mockup.

**How to apply:** Keep the mockup separate from authenticated pilot code. API access assumptions do not prove an adapter works: activation needs the correct location and a verified live contract. Do not boot or mutate shared production stores for preview testing.

Historical service-package CSV evidence is authorized for a customer-facing presentation, not permission to onboard a location or recreate its real daily schedule.

**Why:** The user supplied year-to-date service-package sales from a location they said still needs onboarding, then explicitly asked to use that data to show the customer what the mockup could look like.

**How to apply:** Use employee labels and reviewed aggregate service evidence, not customer identities, VINs, or real RO identifiers. Clearly distinguish historical evidence from simulated assignments and timing. Separate assigned/invoiced work from manager-confirmed independent capability. Verify the meaning of “Technician Hours” before treating it as clocked time: sales exports can closely mirror billed hours. Confirm name aliases and classify specific service packages rather than relying solely on broad categories.

Nonempty normalized technician fields do not establish usable assignment
coverage. Check nested technician identities in archived provider payloads
before requesting another import or a CSV.

Historical technician identities may be shown as manager-reviewed roster suggestions when the current provider list has no usable entries; never treat them as evidence of current employment.

Prioritize historical technicians seen in the last 30 days and retain older or undated candidates at the bottom as “Possible past employees.”

**Why:** The user wants recent staff prioritized without excluding employees on extended leave or loaned to another store. Lack of recent imported work is not termination evidence.

**How to apply:** Use valid invoice dates relative to today, show last-seen dates and archive-coverage caveats, and keep every candidate available for explicit review.

**Why:** The user approved this fallback for Burnett after the live roster remained empty despite named technician evidence in imported repair orders.

**How to apply:** Label historical candidates, leave them unselected, revalidate identity on import, preserve existing lanes/logins, and do not create accounts or automatically activate historical staff.

**Why:** Read-only inspection of Burnett's imported history found
`[object Object]` placeholders where the original API supplied structured
technician IDs and names on service-package lines. Sampled packages also
included multiple technicians; package-level names alone would lose evidence.

**How to apply:** Reject object-string placeholders, retain provider employee
identity and line-level attribution, and distinguish sampled raw-data coverage
from fleet-wide validation. Repairing stored data needs separate authorization;
history is still evidence for manager review, not proof of independent skill.

Brand customization should support enterprise defaults and location-level overrides.

**Why:** The user explicitly requested that locations and/or enterprises can easily make the UI match their own brand.

**How to apply:** Demonstrate inheritance and overrides in the prototype; persist them server-side for the separately authorized pilot. Do not present an unverified palette or placeholder wordmark as official brand assets.

Waiting/drop-off and ride/loaner obligations belong to the vehicle visit, not a technician's paused-job status.

**Why:** The user asked to identify waiting customers and transportation needs, which can coexist with parts/approval waits on individual jobs.

**How to apply:** Keep customer plans separate from ride and loaner states. API access does not imply that any provider supplies those fields; use explicit local input unless its contract is verified.

Shop Workflow must be explicitly enabled per location by platform administrators, never automatically exposed to all stores or inherited from a paid/founder plan.

**Why:** The user requested a controlled store-by-store rollout, with no menu option for unselected stores.

**How to apply:** Preserve opt-in semantics across navigation, direct pages and API access; do not enable real locations during development.

The user supplied Socket Time's Burnett schedule as a usability reference: the scheduling board needs direct drag-and-drop placement, not primarily forms.

**Why:** The user found the first Schedule view cumbersome for arranging a day of work.

**How to apply:** Preserve individual-job, multi-technician scheduling. Keep provider appointments distinct from local work plans, and planned duration distinct from billed hours. Reference screenshots guide interaction and density; they do not authorize copying customer/staff data or changing upstream appointments.

The user clarified that planned job durations should round UP to the next 15-minute increment, not to the nearest (61.8 becomes 75, not 60).

**Why:** Rounding down would allocate less time than the job estimate. The desired planning unit is a quarter hour; billed labor must remain separate.

**How to apply:** Round proposals up with a 15-minute minimum for positive known durations, keep exact quarter hours unchanged, preserve unknown durations, and require review before saving.
