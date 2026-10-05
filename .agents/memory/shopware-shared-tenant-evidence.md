---
name: Shop-Ware shared tenant evidence
description: Shared slug conflicts can represent sibling locations; workspace provider credentials may be sandbox-only.
---

Do not treat a duplicate Shop-Ware tenant slug as a stale alias without authorized
provider evidence. Distinct MOS records can carry the same tenant and slug with
different Shop-Ware location IDs.

The user confirmed that Shop-Ware needs to use the active location ID; preserve
legitimate shared-tenant mappings rather than removing sibling aliases.

**Why:** A tenant hostname identifies the business group, not necessarily the
individual location whose branding should print.

**How to apply:** Bind printing to tenant plus active location, verify provider
location/RO evidence, then enforce global pair uniqueness and authenticated
shop access. Never choose a location solely from the user's accessible shops.

**Why:** Live investigation found State Street and Hoover Street mapped that way.
The workspace was configured for sandbox; explicit production tenant/location
GETs returned 401. That does not prove either saved mapping is wrong.

**How to apply:** Verify tenant hostname and both locations through an authorized
production provider view before preparing a data correction. Preserve conflict
blocking while evidence is missing; never infer ownership from accessible MOS
shops alone. Use direct read-only API requests for investigation because the
normal Shop-Ware client also records API-usage telemetry.

The user confirmed that the workspace is configured for sandbox and production
is configured for production.

**Why:** A production-origin request using workspace credentials returned 401;
that result says nothing about production's own credentials or configuration.

**How to apply:** Perform production ownership checks through the approved
production operational environment. Do not describe workspace authentication
failure as a production configuration failure.

Printing regression tests must exercise the serialized settings and Print
requests, not just resolver inputs or extension message context.

**Why:** Message-only context can be stripped before network transport, and
settings GET may work even when customized POST omits the location identity.

**How to apply:** Test the actual side-panel and worker flow through the wire
boundary across sibling locations, asserting both requests retain the same
location and select the same branding.
