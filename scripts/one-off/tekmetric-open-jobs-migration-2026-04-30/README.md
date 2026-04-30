# Tekmetric Open Jobs Migration (one-off, 2026-04-30)

> **Throwaway tool.** Built specifically for the three-shop acquisition on the night
> of 2026-04-30. Not part of MOS Tools, not part of Detect Dog, not exposed to
> any other user. **Delete this entire folder once the three migrations are
> verified.** If we ever want a real, productized migration tool, that's a
> separate project — do not extend this one.

## What this does (and what Tekmetric's transfer does not)

Tekmetric's account-to-account data transfer copies almost everything from a
source shop to a destination shop **except open jobs** — anything still on the
Job Board (Estimates and Work-in-Progress, i.e. not Posted). For three shops
we cannot reasonably recreate those by hand.

These three browser-console snippets, run from a single Tekmetric session that
has access to both source and destination accounts, **read the full state of
every open RO from the source shop and recreate it in the destination shop**:

- customer + vehicle + RO header + jobs (with labor & parts) + RO notes &
  customer concerns + mileage + service writer + appointment time
- followed by inspections and photos as a separate, isolated step

Posted (closed) ROs, the canned-jobs library, labor rates, inventory,
employees, and shop settings are **not** touched here — Tekmetric's own
transfer covers those.

## Prerequisites

- **Browser:** Google Chrome (any recent version). Firefox / Safari devtools
  may also work but have not been tried; use Chrome.
- **Tekmetric login:** one user account that has access to both the source and
  the destination shop, and can switch between them via the shop switcher. **No
  two-session / two-login flow is supported.**
- **Be on `shop.tekmetric.com`** with that user logged in before pasting
  anything.
- **Open DevTools** (F12 or Cmd+Opt+I) and use the **Console** tab. Keep the
  **Network** tab handy for the discovery step below.
- **Disk space:** dumps and mappings are written to your Downloads folder and
  are typically a few MB per shop.
- **No code edits should be needed between the three shops** — re-run the same
  snippets with a different active shop.

## High-level flow

For each acquired shop, repeat:

1. Switch active shop in Tekmetric to the **source** shop.
2. Paste **`01-dump-source.js`** in the console. It downloads
   `tekmetric-open-jobs-dump-{shopName}-{timestamp}.json`.
3. Switch active shop in Tekmetric to the **destination** shop.
4. Paste **`02-load-core-dest.js`** in the console. Pick the dump JSON when
   prompted. First run is **dry-run by default** — read the planned summary,
   then re-paste with `CONFIRM = true` to actually create. It downloads
   `tekmetric-migration-mapping-{timestamp}.json` when complete.
5. Still on the **destination** shop, paste **`03-load-extras-dest.js`**. Pick
   both the dump JSON and the mapping JSON. Same dry-run-by-default pattern.
6. Spot-check a few migrated ROs in the destination Tekmetric UI before moving
   to the next shop.

If a snippet dies partway through, **just re-run it.** All three snippets
detect already-migrated ROs / inspections / photos via a `[migrated from
RO#X]` marker on the destination customer concern (and similar markers on
inspection titles and photo notes), so re-runs are idempotent. Snippet 2's
pre-scan falls back to per-RO detail fetches when the Job Board summary
doesn't expose `customerConcerns`, so the marker check is robust regardless
of which Tekmetric build is in production at run time. Snippet 2 *also*
runs a per-RO defensive marker recheck inside the write loop — it
searches the destination by the source vehicle's VIN (with a customer
phone/email fallback for VIN-less vehicles) and inspects each candidate
RO's customer concerns — so even if the Job Board pre-scan is incomplete
(failed pagination, RO advanced past the Job Board, etc.), no duplicate
dest RO will be created.

When Snippet 2 detects an already-migrated RO it also **reconciles jobs**:
it fetches the destination RO's current job list, compares it to the
source RO's job list by name, and **creates any jobs that are missing**
from a prior partial run. This means a previous attempt that posted the
RO + concerns + 2 of 3 jobs before crashing will be completed on re-run
instead of being silently treated as "done". The `mapping` JSON records
a `resumedJobs` count for every reused RO.

There is also an **optional** `01b-augment-source-inspections.js` snippet —
only needed if Snippet 3's inline cross-shop inspection read fails (see
"Cross-shop inspection read" below).

## Endpoint discovery — DO THIS FIRST, BEFORE RUNNING SNIPPET 1

These snippets call Tekmetric's **internal** (non-public) web API using the
`x-auth-token` from the live session — same posture as our existing Chrome
extension. We already know two endpoint shapes for sure (mirrored straight
out of `mos-tools-extension/background.js`):

- `GET /api/shop/{shopId}/repair-order/{roId}` — full RO detail (jobs, labor,
  parts, notes, concerns, mileage, service writer, appointment)
- `POST /api/shop/{shopId}/job` — create a job on an existing RO (with labor
  lines + parts)

Everything else (Job Board listing, create customer, create vehicle, create
RO, list inspections, get one inspection's content, create inspection, list
photos, upload photo, attach photo) **must be confirmed by the operator
during a one-time discovery pass before pasting Snippet 1.** The default
endpoint paths in each snippet's `ENDPOINTS` block are the best-effort guesses
that match the existing `/api/shop/{shopId}/...` pattern, but Tekmetric can
and does change these without notice.

**To do discovery — recommended path: use `00-recorder.js`:**

The easiest way to capture every endpoint + request/response shape is to
paste **`00-recorder.js`** in the console, click around the UI to
exercise the flows below, then call `__tekRec.dump()` to download a JSON
transcript. That single file replaces nearly all of the manual
copy-as-cURL work below. Steps:

1. Open Tekmetric on the **source** shop, paste `00-recorder.js`, click
   into the Job Board, into one open RO, into one job, into one
   inspection, into one photo. Run `__tekRec.summary()` to see the
   captured endpoints, then `__tekRec.dump()` to download. Save into
   `fixtures/`.
2. Switch to the **destination** shop with a throwaway test RO. Re-paste
   `00-recorder.js` (it auto-clears state). Click "+ New Job" with one
   labor and one part, save. Create a new inspection. Upload a photo.
   Create a new RO from scratch with one customer concern. Run
   `__tekRec.dump()` again. Save into `fixtures/`.
3. **Delete the throwaway test entities from the destination shop now.**
4. Open the recorder JSON files and use them to confirm/edit the
   `ENDPOINTS` blocks at the top of each snippet.

The recorder strips `Authorization` / `x-auth-token` / `Cookie` headers
before saving, but customer PII / VIN / etc. in request and response
bodies is **not** scrubbed — delete the recorder JSON files when you're
done.

**Alternate manual path (if recorder won't run for some reason):**

1. In Chrome on the **destination** shop (so you do not accidentally write
   anything to the source), open DevTools → **Network** tab. Tick **Preserve
   log**.
2. Walk through the UI flows below, watching the network panel. For each
   one, right-click the relevant request → **Copy** → **Copy as cURL** (or
   just note the method, full path, query string, and request/response
   JSON). Save what you see into the `fixtures/` folder as JSON files with
   the suggested filenames below — these become the executor's source of
   truth.

| UI action to perform | Capture as | Notes |
|---|---|---|
| Open the **Job Board** (estimates + work in progress filters on) | `fixtures/job-board-list.req.json` + `fixtures/job-board-list.res.json` | Confirm the path, query params, status filter values, and pagination shape |
| Open one open **RO** | `fixtures/repair-order-detail.res.json` | Confirm full RO shape — should already include jobs/labor/parts |
| Click **Create Customer** in any flow and save a throwaway customer | `fixtures/create-customer.req.json` + `fixtures/create-customer.res.json` | **Delete the throwaway customer afterward.** |
| Add a **vehicle** to that throwaway customer | `fixtures/create-vehicle.req.json` + `fixtures/create-vehicle.res.json` | Note how it links customer → vehicle |
| Create a new **RO** for that vehicle | `fixtures/create-ro.req.json` + `fixtures/create-ro.res.json` | **Delete the throwaway RO afterward.** |
| Open **Inspections** tab on any RO | `fixtures/list-inspections.res.json` | Path is likely `/api/shop/{shopId}/repair-orders/{roId}/inspections` per `lib/integrations/tekmetric/client.ts:276` |
| Open a single **inspection** | `fixtures/get-inspection.res.json` | Capture full task/group/answer shape |
| **Create inspection** on an RO (any blank canned inspection) | `fixtures/create-inspection.req.json` + `fixtures/create-inspection.res.json` | Delete the throwaway inspection afterward |
| Upload a **photo** to an RO / job / inspection item | `fixtures/upload-photo-presign.req.json` + `fixtures/upload-photo-presign.res.json` + `fixtures/upload-photo-attach.req.json` | Likely a presigned-S3 PUT followed by an attach call |

3. Once captured, open each of the three snippet `.js` files and update the
   `ENDPOINTS` block at the top to match what you saw. Most will already match
   the defaults; do not skip this step.

If discovery shows that **photo upload** is materially harder than expected
(e.g. a multipart pre-signed-S3 flow with browser CORS that does not work
from the console), **ship Snippets 1 + 2 only tonight** and do photos by hand
post-migration. Cores migrated > extras blocked.

## What each snippet writes / reads

| Snippet | Reads | Writes |
|---|---|---|
| 1 — DUMP | live source shop via `x-auth-token` | `tekmetric-open-jobs-dump-{shopName}-{timestamp}.json` to Downloads |
| 2 — LOAD-CORE | the dump JSON (file picker) | new customers / vehicles / ROs / jobs in the destination shop, plus `tekmetric-migration-mapping-{timestamp}.json` to Downloads |
| 3 — LOAD-EXTRAS | the dump JSON + the mapping JSON (file pickers) | new inspections + uploaded photos on the already-migrated destination ROs |

The dump file goes straight to your local Downloads via a browser blob
download. **The script does not POST the dump anywhere off your machine.**
That dump file contains real customer PII — treat it accordingly and delete
it once the migration is verified.

## Reading the success / failure output

Each snippet prints two `console.table`s at the end:

- **Successes:** one row per source RO, with the source RO#, dest RO#, and
  step counts (jobs created, labor lines, parts, etc.).
- **Failures:** one row per source RO that failed, with the source RO#, the
  step that failed (`createCustomer` / `createVehicle` / `createRo` /
  `createJob[i]` / `createInspection` / `uploadPhoto`), and the error response
  body.

Failures are **per-RO**: a single bad RO does not abort the rest of the run.
To retry, just re-paste the same snippet — successful ones are skipped via
the `[migrated from RO#X]` marker.

## Cross-shop inspection read (Snippet 3 fallback) — `01b-augment-source-inspections.js`

Snippet 3 needs the **full inspection content** (task answers, findings, etc.)
which Snippet 1 only stored as IDs. By default, Snippet 3 tries to fetch each
source-shop inspection inline using the same Tekmetric session — i.e. it
hits `/api/shop/{SOURCE_shopId}/inspection/{id}` while you are sitting on the
destination shop. Many Tekmetric sessions allow this because the user has
access to both shops.

**If that cross-shop read fails** (you'll see a 401/403 in the failures table
with `source inspection fetch failed`), do this:

1. Switch the active Tekmetric shop back to the **source** shop.
2. Paste **`01b-augment-source-inspections.js`** in the console and pick the
   original Snippet-1 dump JSON. It downloads
   `tekmetric-open-jobs-dump-{shop}-{ts}-augmented.json` — same shape as the
   original dump but with a `fullContent` field on every inspection.
3. Switch back to the destination shop and re-paste **Snippet 3** with the
   augmented dump file. Snippet 3 detects `fullContent` and skips the
   cross-shop fetch entirely.

This step is rarely needed in practice — try the inline path first.

## Job labor rate / technician fidelity

By default Snippet 2 **preserves** each source labor item's rate and
technician on the new destination job, falling back to dest defaults
when the source row doesn't have them. This keeps the customer-quoted
rate from the old shop intact across the migration.

If during the smoke test you see Tekmetric reject the job-create
payload with a labor-rate or technician validation error, flip
`FORCE_DEST_LABOR_RATE_AND_TECH = true` at the top of Snippet 2 and
re-run. That mode mirrors the extension's `createTekmetricJob` exactly:
every labor item gets the destination RO's labor rate, and every job
gets the destination RO's `defaultTechnician`.

## Photo attachment to the right job / inspection item

Snippet 2 records a `srcJobId → destJobId` mapping for every job it creates
(and tries to recover the same mapping for already-migrated ROs by matching
job names) and writes that into the migration mapping JSON. Snippet 3 uses
that mapping plus a per-inspection `srcItemId → destItemId` mapping it
builds while creating inspections, so each migrated photo is attached to
the equivalent destination job or inspection item — not just the RO. If a
source photo references a job or inspection item that didn't make it
across (e.g. the job creation failed in Snippet 2 for that one), the photo
falls back to RO-level attachment.

## What to do if a snippet dies partway

1. Note the last source RO# you saw a "success" log for.
2. Re-paste the same snippet with the same JSON file. Idempotency handles it
   — anything already migrated will be skipped, picking up where it left off.
3. If the **token expired** mid-run (`401` in the failures table), reload
   Tekmetric, open one RO so a fresh `x-auth-token` is issued, then re-run.

## Known limitations — read before running

- **Internal API.** Tekmetric does not document or guarantee these endpoints.
  A Tekmetric web release between now and when you run this can break
  anything. Re-do the discovery pass if it has been more than a couple of
  days.
- **Do not run during a Tekmetric incident** (status page red) — partial
  failures are very hard to reconcile.
- **Photo CORS.** Re-uploading photos requires fetching the source photo from
  Tekmetric's CDN and re-PUTing it to a destination presigned URL. If the
  source CDN does not allow `cross-origin` reads from `shop.tekmetric.com`,
  Snippet 3's photo step will fail and you'll need to download photos
  manually and re-attach in Tekmetric's UI.
- **One Tekmetric session, one user.** No two-tab / two-login mode. The
  active shop must match what each snippet expects (the snippets check this
  and refuse to run if not).
- **No retries for write failures.** If a `POST` returns a non-2xx, that RO
  is logged in the failures table and the next RO is attempted. Re-paste to
  retry.

## Manual smoke test plan (no automated tests for a throwaway)

Before doing all three real shops, do this once on a low-stakes pair of
shops (or pick the smallest source shop and use its destination):

1. Pick **one** open RO in the source that you can identify easily (small
   one with 1–2 jobs, a couple of labor lines, maybe one part, one
   inspection, one photo if any).
2. Run Snippet 1 — confirm a dump file lands in Downloads with that RO in
   it. Open the JSON, eyeball the customer / vehicle / jobs / labor / parts.
3. Run Snippet 2 with `CONFIRM = false`. Read the planned summary. Make sure
   the source shop name and dest shop name in the prompt look correct.
4. Run Snippet 2 with `CONFIRM = true`.
5. Open the destination shop in Tekmetric. Verify on that one RO:
   customer, vehicle (year/make/model + VIN + plate + mileage), RO header,
   jobs, labor (hours + rate + tech), parts (cost / retail / part #), RO
   notes, customer concerns (with the `[migrated from RO#X]` prefix),
   service writer, appointment time. **Pay particular attention to the
   customer concern body text** — confirm the original concern wording
   was preserved verbatim (only the `[migrated from RO#X]` marker should
   be added in front). If the concern is just the marker with no body,
   that means the concern-shape normalization didn't recognize this
   build's payload and the original text was dropped. Stop and report.
6. Run Snippet 3 with `CONFIRM = false`, then `CONFIRM = true`. Verify the
   inspection is present on the dest RO with the same task answers, and
   the photos are attached in the same place.
7. **Delete** that test RO + customer + vehicle from the destination shop
   before doing the real run.
8. Then run all three real shops back-to-back.

## After you're done

- Verify all three destination shops look correct in the Tekmetric UI
  (sample at least 3 ROs per shop — large, small, and one with inspections
  + photos).
- **Delete the dump JSON files and mapping JSON files from your local
  Downloads folder** — they contain customer PII.
- **Delete this entire folder
  (`scripts/one-off/tekmetric-open-jobs-migration-2026-04-30/`)** in a
  follow-up commit. It has no place living on in the repo.
