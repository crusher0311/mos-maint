---
name: Protractor outbound export coverage
description: Redistribution scope and latest-snapshot limitations for enterprise outbound exports.
---

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
