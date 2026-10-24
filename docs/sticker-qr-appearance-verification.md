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

## Physical-size release checklist (requires printer/operator)

Before customer rollout, print representative generated, opaque custom and
transparent custom codes on white, off-white (#FFFAF0), light gray (#EEEEEE)
and a dark sticker (QR must retain white). Use each supported sticker size,
including the smallest QR layout the shop actually uses. Test desktop PNG
printing, Quick Sticker, extension printing and mobile PDF/AirPrint at 100%
scale with no fit-to-page adjustment. Scan on at least two phone cameras in
normal and dim lighting. Verify the uploaded destination and unchanged
generated destination, not merely that a phone detects a QR.

Check the blank border remains visible and isn't cropped by printer margins.
Repeat after switching back to generated, replacing/removing custom artwork,
and excluding QR. Missing custom media must stop generation, not print MOS
artwork. Retain dated printer/model/material/results evidence before release.
