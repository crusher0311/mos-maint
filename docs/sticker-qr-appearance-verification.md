# Sticker QR appearance release verification

No production configuration or data changes are needed for this feature.
Appearance transforms operate on copies of generated images, not their saved
HoverCode IDs, target URLs or cache bytes. Custom uploads are scoped to the
authenticated shop and deliberately omitted from enterprise settings copying.
Removing artwork does not change the active source: custom mode fails closed
until a manager replaces it or explicitly selects MOS-generated.

## Image policy

PNG, JPEG and WebP uploads must decode successfully, contain a readable QR,
be at most 500KB (including normalized PNG output), at most 2048 pixels on
either edge and at most 4,194,304 pixels. Animated images and SVG uploads are
not accepted. Images are orientation-normalized without cropping or resizing.
QR contents are decoded only to check readability; destinations are never
visited, logged or persisted separately.

Matching accepts six-digit hex colors with every sRGB channel at least 224.
Other colors retain white. Generated near-white neutral pixels are replaced
without touching dark modules or encoded data. Custom opaque pixels are
preserved; only transparent pixels receive the safe background. Existing
quiet zones and aspect ratio are retained. The policy is conservative software
validation, not a guarantee about ink, paper or printer quality.

## Offline checks

Run with outbound network blocked:

```
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' node --import tsx tests/sticker-custom-qr-routes.smoke.ts
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node --import tsx --test tests/sticker-qr-appearance.test.ts tests/sticker-dynamic-qr.test.ts
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node --import tsx tests/extension-sticker-hovercode.smoke.ts
```

For the isolated browser controls, run
`node tests/shop-dispatch-browser/sticker-qr-style.cjs`, start the existing
Shop Workflow offline checks workflow, then run
`node tests/shop-dispatch-browser/sticker-qr-check.cjs`. Set
`DEMO_CHROMIUM_PATH` to an installed Chromium executable if the Playwright
browser cache is unavailable. The fixture is `/sticker-qr.html`; it mounts the
real controls with synthetic endpoints and never loads the authenticated app.

## Practical pilot check (requires printer/operator)

For an initial pilot, use one representative shop printer, its usual label
material and its usual printing method. The full printer/material matrix below
is recommended for wider rollout, not a gate for the initial pilot.

- Print the smallest QR layout the shop uses at 100% scale, without fit-to-page.
- Test a generated code and the custom code the shop intends to use.
- Scan both with two phone cameras in normal lighting. Confirm the intended
  destination, not just QR detection; the generated destination must be unchanged.
- Check that the blank border remains visible and is not cropped by margins.
- Spot-check a dark sticker background: the QR background must retain white.
- Switch from custom back to generated and verify the generated destination.
  Replace custom artwork and check the replacement destination. Remove custom
  artwork while custom remains selected: generation must stop rather than
  silently substitute MOS artwork.
- Exclude QR and confirm the printed sticker contains no QR.

A short written confirmation is sufficient; photos and a formal evidence
package are not required. Note any failure or untested item rather than treating
it as a pass. Fix scan, destination or cropping failures before using that
configuration with customers.

Suggested confirmation format (fill in actual observations):

> Date; printer make/model; label material; sticker size/smallest QR layout;
> print method and scale; QR source/background tested; phone models and scan/
> destination results; border, dark-background, source-switch, replacement,
> removal and QR-exclusion results; failures or items not tested.

## Wider-rollout recommendations

As more shops or printing setups are introduced, expand checks to generated,
opaque custom and transparent custom codes on white, off-white (#FFFAF0),
light gray (#EEEEEE) and dark backgrounds (QR must retain white). Include each
supported sticker size and desktop PNG, Quick Sticker, extension printing and
mobile PDF/AirPrint, at 100% scale without fit-to-page. Repeat two-phone scans
in normal and dim lighting and the destination/border checks above.

Record the printer/model/material and results for each configuration actually
tested. A successful pilot does not establish quality on every printer or label.

## Verification status and scope

Physical printing and phone scans have not been performed in the isolated
development environment. This document defines the simplified pilot check; it
does not certify physical print quality or record a completed pilot. Software
decoding cannot establish ink, paper or printer quality.

Changing this checklist does not change application validation, QR appearance
rules or production configuration, and does not authorize a production rollout.
