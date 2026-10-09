---
name: Sticker QR compatibility
description: Preserve printed HoverCode behavior when issuing new first-party sticker QRs.
---

Do not repoint a legacy HoverCode merely to make future prints first-party.
Issue a replacement for future prints while leaving the old shortlink intact.
Legacy direct-booking HoverCodes retain their booking-setting update behavior;
first-party targets must never be overwritten by a raw booking URL.
Retain the legacy update handle when replacing the active print code; otherwise
the old shortlink silently stops following later appointment-URL changes.

**Why:** The product explicitly requires already-printed stickers to keep their
existing behavior. New vehicle reports also need a different target per vehicle,
so mutating a shared shop shortlink could send old stickers to the wrong report.

**How to apply:** Treat image, target metadata, and HoverCode ID as one cache
identity. Publish them together only after the image is usable; do not certify
an old cached image by updating only its target marker.
