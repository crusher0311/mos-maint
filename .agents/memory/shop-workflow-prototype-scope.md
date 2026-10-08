---
name: Shop workflow prototype scope
description: Product model and isolation boundary for Detect Dog scheduling exploration.
---

The scheduling concept is a vehicle visit containing individual jobs and multi-technician handoffs, not one appointment block per vehicle.

**Why:** The user wants to evaluate the workflow experience before committing to a production scheduling system.

**How to apply:** Preserve separate arrival, work, and promise times and distinguish book labor, illustrative predicted technician time, active time, and waiting time.

Keep the presentation artifact fictional and frontend-only. The user separately authorized a one-location production pilot, assuming API access will be available.

**Why:** The original prototype scope excluded live services; the user subsequently explicitly chose the production pilot when asked to distinguish it from extending the mockup.

**How to apply:** Keep the mockup separate from authenticated pilot code. API access assumptions do not prove an adapter works: activation needs the correct location and a verified live contract. Do not boot or mutate shared production stores for preview testing.

Historical service-package CSV evidence is authorized for a customer-facing presentation, not permission to onboard a location or recreate its real daily schedule.

**Why:** The user supplied year-to-date service-package sales from a location they said still needs onboarding, then explicitly asked to use that data to show the customer what the mockup could look like.

**How to apply:** Use employee labels and reviewed aggregate service evidence, not customer identities, VINs, or real RO identifiers. Clearly distinguish historical evidence from simulated assignments and timing. Separate assigned/invoiced work from manager-confirmed independent capability. Verify the meaning of “Technician Hours” before treating it as clocked time: sales exports can closely mirror billed hours. Confirm name aliases and classify specific service packages rather than relying solely on broad categories.

Brand customization should support enterprise defaults and location-level overrides.

**Why:** The user explicitly requested that locations and/or enterprises can easily make the UI match their own brand.

**How to apply:** Demonstrate inheritance and overrides in the prototype; persist them server-side for the separately authorized pilot. Do not present an unverified palette or placeholder wordmark as official brand assets.

Waiting/drop-off and ride/loaner obligations belong to the vehicle visit, not a technician's paused-job status.

**Why:** The user asked to identify waiting customers and transportation needs, which can coexist with parts/approval waits on individual jobs.

**How to apply:** Keep customer plans separate from ride and loaner states. API access does not imply that any provider supplies those fields; use explicit local input unless its contract is verified.

Shop Workflow must be explicitly enabled per location by platform administrators, never automatically exposed to all stores or inherited from a paid/founder plan.

**Why:** The user requested a controlled store-by-store rollout, with no menu option for unselected stores.

**How to apply:** Preserve opt-in semantics across navigation, direct pages and API access; do not enable real locations during development.
