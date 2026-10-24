---
name: Admin refresh scroll retention
description: Background refresh feedback can shift the viewport despite retaining table nodes.
---

Keep refresh/error feedback outside the table's document flow when preserving scroll.

**Why:** The isolated large-fleet browser test observed a 30px viewport shift from adding a status paragraph above retained rows; retaining React row keys alone did not prevent browser scroll anchoring.

**How to apply:** Test actual scroll coordinates during refresh, not just continued presence of rows. Avoid collapsing expanded detail content during background reloads.
