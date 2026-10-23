---
name: Protractor outbound export coverage
description: Redistribution scope and latest-snapshot limitations for enterprise outbound exports.
---

The user chose PostgreSQL for new export control state while retaining mixed-store
raw-source reads.

**Why:** They do not want additional Mongo dependencies for configuration,
checkpoints, retries or receipts. Some raw snapshots still exist only in Mongo;
migrating those is a separate effort and must not silently become a prerequisite.

**How to apply:** No new Mongo export-state writes or fallback. Require a separately
approved PG installation and coordinated release; leave existing empty Mongo
collections untouched. Keep raw-data migration and service activation separate.

Export state must use a dedicated restricted PG login, not the application's
shared PG identity.

**Why:** The read-only production review confirmed the shared app connection uses
the broadly privileged postgres role. Narrowing that role could break unrelated
features; adding a restricted role alone does not make the app use it.

**How to apply:** Keep export-state credentials separate with no shared fallback.
Keep raw-source clients unchanged and require actual-role checks before state DML.

For parameterized JSONB in the export adapter, bind JSON text through an explicit
text cast before casting to JSONB.

**Why:** postgres-js inferred native boolean parameters despite a JSONB cast, and
pre-stringified values bound directly as JSONB became JSON strings instead of
objects. Real PostgreSQL tests caught what in-memory fakes missed.

**How to apply:** Preserve tests for objects, boolean predicates, numeric
revisions and Date roundtrips when changing the adapter or driver.

Keep the outbound feed opt-in and explicitly approved per destination and shop;
enterprise membership alone never expands recipients or source shops.

**Why:** The user authorized work orders and invoices only, with DVI potentially
later. They did not authorize activation, real customer exports, backfills or
database cutover changes. Available caches are latest snapshots, not a complete
provider change log.

**How to apply:** Preserve MOS-observed coverage language and require separate
approval for live rollout. Do not claim every intermediate change, deletion
detection or full history. New datasets need their own confirmed contract.

Synthetic export preparation authorizes only fictional receiver traffic and
read-only readiness assessment, not real delivery or production setup.

**Why:** The user approved testing and assessment before considering a one-shop
pilot; implementation being merged is not activation approval.

**How to apply:** Keep destination ownership, exact shop redistribution authority,
schedule/timezone, snapshot choice, secret installation and explicit resume as
separate pilot gates. Workspace deployment/env metadata cannot establish the
state of separately hosted production web and worker services.

Export activation must not resume unrelated backfill work.

**Why:** The general queue worker starts backfill consumers and an incremental
loop alongside optional exports. A webhook pilot is not permission to restart
those workloads or change their operating schedule.

**How to apply:** Use a separately scoped export-only process for the pilot.
Keep existing suspended services and their schedules unchanged unless explicitly
approved. Local lifecycle verification is not approval to install or activate it.

Mocked HTTPS requests do not validate Node's real address-family selection.

**Why:** The first public receiver readiness check failed before HTTP with
ERR_INVALID_IP_ADDRESS despite passing transport mocks. Node's automatic
family selection called the single-address DNS override with all:true, which
requires an array result.

**How to apply:** Keep SSRF address pinning intact and exercise actual Node socket
selection in a loopback-only fixture whenever changing custom lookup handling.
For an explicitly IPv4-validated sender, keep connection family consistent with
that validation; do not disable pinning or introduce a second DNS resolution.
