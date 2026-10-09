---
name: Workflow shared branding
description: Inheritance and safe logo reuse constraints for the authenticated pilot.
---
Workflow-specific location brands remain intentional whole-object overrides; shop identity fills individual fields before enterprise defaults. Shared logos must not be copied into the smaller manual workflow upload field.

**Why:** Reusing Shop Branding must not overwrite deliberate customization or make otherwise valid shared images fail the separate manual-upload validator.

**How to apply:** Keep resolved display branding separate from persisted manual drafts. Support only embedded raster images for palette generation; unsupported formats (including existing shared SVGs) fall back rather than fetching or executing image content. Never enable real pilot shops or start shared-store-backed servers for visual testing; use offline fixtures.

Accept normal-sized raster uploads by resizing them locally rather than raising the persisted logo or request-body limits.

**Why:** The small embedded-storage limit otherwise rejects ordinary business logo files; keeping it small bounds every workflow snapshot and save.

**How to apply:** Validate format and dimensions before decoding, preserve transparency, and distinguish upload failures from revision conflicts or changes not yet released.
