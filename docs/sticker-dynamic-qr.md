# Dynamic sticker QR destinations

In **Settings → Stickers → QR scan destination**, choose appointment booking
(the default), shop website, or vehicle health report (VHI). Save the setting;
new first-party QR links read it on every scan, so changing it does not require
reprinting.

## Vehicle reports

Stickers generated with a valid 17-character VIN carry an opaque, random
vehicle reference scoped to the issuing shop, even before the shop selects VHI.
The reference contains neither a VIN nor a report token. It is a durable bearer
link: anyone possessing the printed sticker can scan it. Treat copies like
customer report links. References are stored in `sticker_vehicle_references`;
deleting an individual reference revokes that sticker's report access.
Do not TTL-delete these records while stickers remain in use.

Each VHI scan mints a fresh token expiring one hour after that scan, using the
existing report-token model. Both scan resolution and the report API enforce
the shop's maintenance entitlement. Report redirects are not cacheable.

No/malformed/unknown references, a reference issued to another shop, or missing
maintenance access fall back to appointment booking, then the shop website.
Website mode prefers the website, then booking. With neither URL configured,
the scan displays the contact-shop message. Only HTTP(S) destinations are used.

Quick Sticker on vehicle/analyzer pages uses the page's VIN; the global quick
sticker elsewhere is generic. Dashboard vehicle stickers and extension stickers
also carry their VIN context. Vehicle QRs bypass the generic shop image cache.
Incomplete or nonstandard VINs still print with a generic shop QR; they never
receive a report reference.

## Compatibility

Previously printed static QRs encoding booking/website URLs **cannot be
repointed**. Generate and print a new sticker to get a dynamic first-party link.
Existing HoverCode shortlinks are not deleted or retargeted by generation:
old non-first-party targets are left alone and a new code is created for future
prints. Existing legacy booking-target HoverCodes retain their booking-URL
update behavior: their IDs are retained separately when the active print code
is replaced, and later appointment-URL edits update those legacy IDs only.
Both `/sticker/redirect/{shopId}` and
`/api/sticker/redirect/{shopId}` remain supported.

Old generic first-party links have no vehicle reference and therefore continue
to use the fallback destinations, even when VHI is selected.

The server trusts only cache entries tagged with their first-party target URL.
Legacy cache images are skipped, not used for new stickers. Settings changes
do not overwrite first-party HoverCode destinations with raw booking URLs.

## Operations

`sticker_qr_scans.destinationKind` records `vhi`, `appointment`, `website`, or
`none`. Old rows without that field predate this feature. Scan logs do not store
minted tokens or the vehicle reference. No customer analytics dashboard is added.
The public base URL and report signing configuration must already be configured
as for existing sticker/report features. No production data migration is needed.
