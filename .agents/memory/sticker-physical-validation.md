---
name: Sticker physical validation
description: Limits of browser print evidence and same-hardware acceptance for label sizing.
---

Keep nominal stock dimensions separate from raster resolution. Do not introduce
platform-specific shrink factors or change saved artwork to compensate for
unmeasured printer behavior.

**Why:** Patriot Auto & Fleet Svcs reported extra pages for 2×3 and clipping for
2×2 with Mac edge-to-edge enabled while an older extension worked. Differences
in generated HTML and inch dimensions are verified, but they do not establish
the printer-driver cause. Legacy archive dimensions do not prove the customer's
exact old build or its remote print-document behavior.

**How to apply:** Treat Linux Chromium PDF page-count/content-bounds checks as
browser evidence only. Compare old/new output on identical Mac hardware and
settings (edge-to-edge on/off), with measured labels and a Windows control,
before claiming physical parity. CSS cannot override driver media defaults or
borderless overscan. Record unavailable hardware checks as pending.
