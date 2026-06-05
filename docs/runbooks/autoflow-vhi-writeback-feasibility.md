# AutoFlow VHI Write-Back — Feasibility (Task #586)

**Verdict: GO for all three actions.** AutoFlow's DVI is a jQuery/PHP app whose own
web UI writes through a single same-origin endpoint authenticated by the logged-in
**session cookie**. The MOS extension content script runs on that same origin, so it
can perform the identical writes in the page context. No AutoFlow REST API, no
`x-auth-token` relay, and no captured-credential plumbing are required.

Confirmed against: a real Network-tab HAR of a tire-status save, plus the shop's
own (publicly fetchable, un-authed) DVI source scripts:
`jquery.atme.uploads3.js`, `jquery.atme.multiaxle.js`, `jquery.atme.notes.js`,
`jquery.atme.rvh.js`.

## The write channel

- **Endpoint:** `POST {shopBase}/Admin/dvi_v3/request.php`
  (reads use `getcontent.php`). Generic wrapper in the page is `$.fn.request(params)`.
- **Body:** `application/x-www-form-urlencoded`.
- **Auth:** same-origin session cookie (`sec-fetch-site: same-origin`,
  `x-requested-with: XMLHttpRequest`). The write is keyed by **`status_id`** — the
  DVI/RO id, which is also in the page URL: `…/Admin/dvi_v3/index.php?status_id=NNNN`.
- **Action selector:** every call carries a `request_type` field.

### Status encoding (consistent across item types)
- `2` = green / good (tire `sub_status` `G`)
- `1` = yellow / monitor (tire `sub_status` `O`)
- `0` = red / needs attention (tire `sub_status` `R`)

## Per-action go/no-go

### 1. Pre-fill DVI — GO
Two item shapes:

- **Tires** — `request_type=save_multi_axle_tire_results` (full payload captured):
  `status_id`, `tire_template[axle][tires]`, and per position
  (`LF/RF/LR/RR/…`): `tire_info[POS][tire-status]` (0/1/2),
  `[sub_status]` (R/O/G), `[tread-depth]`, `[sub_status_tag]`, `[notes]`,
  plus `tire_axles[n]` labels.
- **Regular inspection items** — `request_type=update_sheet`
  (`update_video` for video rows): `status_id`, `sheet_id`, `inspec_id`,
  optional `group_id`, the item status, free-text `notes`, and optional
  `recommendation[]` + `rec_sms_code` (canned-rec codes). Params are the modal
  form's named inputs/textarea, HTML-escaped server-side expectations apply
  (`<`/`>` are entity-encoded by the page before send).

### 2. Enhance technician notes — GO
Same `update_sheet` write, `notes` field only. Read current notes from the DVI
read API (or page DOM), send to the MOS enhance endpoint, write the rewritten text
back. No new channel needed.

### 3. Add recommendations / "add all to concerns" — GO
AutoFlow's equivalent of Tekmetric concerns is **RVH ("Reason Vehicle is Here")**.
- `request_type=add_rvh` (returns `data.rvh_id`), `update_rvh`, `delete_rvh`,
  `get_rvh`. Posted to `request.php` via `$.fn.requestRVH(params)`.
- Add payload: `status_id`, recommendation `details`, `notes`, optional
  `acknowledged`, `skip_mapping`, and optional tagged DVI items.

## Recommended write mechanism
Perform writes **in the AutoFlow page context** so the session cookie is attached
automatically — either a same-origin `fetch(url,{method:'POST',credentials:'include',
headers:{'X-Requested-With':'XMLHttpRequest'}, body})` from the content script, or
an injected MAIN-world helper that reuses the page's own `$.fn.request` /
`$.fn.requestRVH`. Mirror Tekmetric's UX: per-shop feature-flag gating, a review
modal before writing, and added/skipped/failed toasts.

## Risks / constraints
- **Live customer ROs.** Writes hit a real shop. Flags must default OFF; ship behind
  a confirm/review modal; have the shop owner test before enabling.
- **Cannot be tested from the isolated env** — no AutoFlow session here. Needs a
  logged-in tester (Brandon's shop).
- **`update_sheet` field exactness.** Tire payload is captured 1:1; the regular-item
  payload is reconstructed from source. Capture one real `update_sheet` save to lock
  the field names before enabling for shops.
- **Sniffer note:** AutoFlow serves **no CSP header**, so the extension's API Sniffer
  (inline-injected page hook) should work; the earlier "0 captures" was a capture
  session with no write action, not a CSP block. The Network tab remains the reliable
  fallback.

## Source pointers
- DVI write wrapper: `…/Admin/dvi_v3/js/jquery.atme.uploads3.js` (`$.fn.request`)
- Tires: `…/jquery.atme.multiaxle.js` (`saveMultiAxle`, `saveTire`)
- Items/notes: `…/jquery.atme.notes.js` (`update_sheet`)
- Recommendations: `…/jquery.atme.rvh.js` (`add_rvh`/`update_rvh`, `requestRVH`)
- Captured write: `attached_assets/brandonsrepaircenter.autotext.me_1780688895064.har`
