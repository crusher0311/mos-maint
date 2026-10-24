---
name: CARFAX setup without Maintenance
description: Configuration authorization and the meaning of testing a saved CARFAX ID.
---

Allow authenticated shop-scoped CARFAX settings saves even without Maintenance,
including authorized Ghost Mode sessions. Warn that Maintenance features remain
disabled; saving configuration never enables product usage.

**Why:** The user explicitly requested configuration independent of Maintenance
and confirmed that “test it” means save/reload verification, not a paid CARFAX
validation request.

**How to apply:** Keep usage endpoints gated. Do not describe saving a Location
ID as successful upstream connection validation or authorize paid calls from
this configuration exception.
