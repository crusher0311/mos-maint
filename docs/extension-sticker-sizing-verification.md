# Extension sticker sizing: verification and hardware handoff

## Scope and evidence

The pre-change Tekmetric, Shop-Ware, AutoFlow and side-panel popup print
functions were executed offline with synthetic PNGs for 2×2 and 2×3.
Their actual generated documents used `@page size: auto`, 100% body width/height,
and a fixed image box without `object-fit: contain`. The API reported
1.97×1.97 inches and 1.97×2.96 inches respectively. The website instead
requests nominal page, body and image dimensions with contain-fit.

These are verified differences, **not proof of the Mac driver root cause**.
The available legacy-archive evidence in the task establishes nominal
dimensions only; its remote print document and whether it is the customer's
exact installed build remain unverified. No same-hardware old/new comparison
was possible in this Linux environment. Baseline captures are local ignored
outputs in `generated-artifacts/sticker-sizing/baseline-*`.

## Contract

All extension print documents now request nominal stock dimensions:
1.5×2.25, 2×2, 2×2.5, 2×3, and 2×3.5 inches (width × height).
The API and website/PDF nominal map live in `lib/sticker-print-dimensions.ts`;
the packaged extension's dependency-free map is checked against it in tests.
The extension uses the size identifier, not old reduced inch fields, so it
can work with the existing API during staged rollout.

Raster dimensions remain 443×665, 591×591, 591×739, 591×887 and 591×1035.
Pixel rounding is accommodated by contain-fit, not stretching or cropping.
There is **no added content inset or arbitrary shrink factor**: no available
hardware evidence supports one. Overflow is not hidden to suppress a page.
Saved designs, wording, logos, QR content and destinations are unchanged.
Mobile/AirPrint PDF behavior and its existing inset are untouched.

Quick print and interval-menu print converge on the same provider function.
Side-panel prints route to that function, or the shared popup document on
unsupported content-script paths (including Shopmonkey). Protractor has no
registered content adapter. No new provider capability is implied.
The existing Tekmetric shop/RO checks before loading and before printing,
bound-tab failure behavior, and popup-blocked handling are retained.
Image errors now fail visibly; successful images trigger at most one dialog.

## Reproducible offline checks

Run:

```
node --import tsx tests/extension-sticker-print-sizing.test.ts
node --import tsx tests/extension-sticker-messages.smoke.ts
node --import tsx tests/sticker-text-formatting.smoke.ts
node --import tsx --test tests/sticker-qr-sizing.test.ts
```

The geometry check requires installed Chromium, `pdftoppm`, and existing project
Node dependencies. It blocks browser network requests and uses only synthetic
images. It executes the actual three adapter functions and popup function,
then renders each generated document plus the website control to PDF.
For all five stock sizes it checks nominal page dimensions, exactly one page,
DOM bounds, unchanged image payload, contain-fit, all four rasterized PDF edge
markers, and an undistorted center square. It also checks delayed/cached/broken
image readiness, duplicate load events, popup blocking, manifest load order,
Shop-Ware reinjection dependencies, and Tekmetric context changes.
HTML/PDF/PNG evidence is regenerated under ignored `generated-artifacts/`.

Passed in Linux Chromium 138. These are browser/PDF results, not physical
Windows or macOS print results. The existing message-routing, formatting and
QR-sizing checks passed. No production server or live data was used.
Project-wide `npm run typecheck` also passed. A visual check of the synthetic
2×3 popup document through the existing offline fixture server showed its full
border and undistorted center square; the only browser resource error was an
unprovided resource (the fixture does not supply application assets).

## Pending physical acceptance — do not mark as passed

Obtain from Patriot Auto & Fleet Svcs:

- Mac model, macOS version, browser/version, printer make/model, driver/version.
- Exact old and updated extension versions; retain the working old package.
- Selected stock name and measured dimensions, feed direction and orientation,
  scaling, margins, headers/footers, and edge-to-edge setting.
- Whether the unwanted second page is blank or contains artwork.
- Photos with a ruler and screenshots of each print dialog; if possible the
  working old extension's generated print HTML/PDF (remove customer details).

On the **same Mac/printer/stock and saved design**, print old and updated
extension 2×2 and 2×3 labels with edge-to-edge ON, then OFF. Record page/label
count, measured artwork width/height, all-edge content visibility, QR readability,
and media selection for each run. Repeat quick, interval-menu, side-panel and
popup paths. Record when edge-to-edge OFF changes media to 2×2.5 rather than
assuming CSS controls that setting. Run the same stock/design matrix on a
Windows Chrome/Edge control, plus the other supported sizes.

All physical comparisons and measurements above are **pending**. If the driver
ignores CSS media size, explicitly select matching stock/orientation and record
the requirement. Browser CSS cannot override OS media defaults, hardware
nonprintable areas or borderless overscan. Do not compensate by editing a shop's
design or adding an unmeasured platform-specific shrink factor.

## Release boundary

An extension update is required; an API-only rollout cannot replace the print
document in installed clients. Release packaging must include
`sticker-print-core.js`, the manifest load order, side-panel script, and
Shop-Ware reinjection change. A separately authorized release should assign the
next extension version and reload existing provider tabs. The current version
has intentionally not been bumped or published. No app deployment, shop setting
change, production write or extension-store submission was performed.
