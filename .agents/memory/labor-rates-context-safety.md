---
name: Labor Rates context safety
description: Diagnostic distinction and read-only identity resolution constraints for Rates.
---

Treat an extension “No accessible shop configured” response as a MOS scoped
identity lookup failure, not proof of a disconnected provider.

**Why:** Provider connectivity, provider identity mapping, and effective MOS
membership are separate checks. A scoped lookup failure cannot establish which
of those checks needs repair.

**How to apply:** Compare the failing and working requests' active provider/SMS
identity and effective MOS membership before claiming a shop-specific cause.
Keep live membership or mapping changes operator-approved.

Rates settings resolution must remain read-only, rather than inheriting
provider discovery/auto-learning from general extension lookup flows.

**Why:** Merely loading or saving pricing configuration must not create a new
provider mapping or silently select a different shop.

**How to apply:** Preserve this constraint when consolidating lookup helpers;
reuse provider-aware authorization without invoking discovery or mapping writes.