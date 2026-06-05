---
name: AutoFlow DVI write-back path
description: How the MOS extension can write into AutoFlow's DVI (statuses, notes, recommendations) — endpoint, auth, request_types.
---

AutoFlow (autotext.me) DVI is a jQuery/PHP app. Its own UI writes through ONE
same-origin endpoint, cookie-authenticated — so the extension content script (same
origin) can replicate writes in the page context. NOT the Basic-Auth REST client
(`lib/integrations/autoflow/client.ts`, read-only GET /api/v1/dvi/{invoice}), and
NO `x-auth-token` relay (that's Tekmetric's model).

**Channel:** `POST {shopBase}/Admin/dvi_v3/request.php`, form-urlencoded, session
cookie, keyed by `status_id` (the DVI/RO id, also in URL `index.php?status_id=NNNN`).
Reads via `getcontent.php`. Every call carries a `request_type`. Page wrapper is
`$.fn.request(params)` (in `jquery.atme.uploads3.js`).

**request_types:**
- Tires: `save_multi_axle_tire_results` (`tire_info[POS][tire-status|sub_status|tread-depth|notes]`).
- Regular items + notes: `update_sheet` (`status_id,sheet_id,inspec_id,group_id?,notes,recommendation[],rec_sms_code`); `update_video` for video rows.
- Recommendations = AutoFlow "RVH" (Reason Vehicle is Here): `add_rvh` (returns rvh_id) / `update_rvh` / `delete_rvh` / `get_rvh` via `$.fn.requestRVH`.

**Status encoding:** 2=green/good (tire sub_status G), 1=yellow (O), 0=red (R).

**Why it matters:** all three Task-586 write-back actions (pre-fill DVI, enhance
notes, add-to-concerns) are FEASIBLE this way. The shop's DVI source JS is publicly
fetchable un-authed (`/Admin/dvi_v3/js/jquery.atme.*.js`) — read it to confirm exact
payloads instead of guessing. AutoFlow sends NO CSP header.

**How to apply:** write in page context (same-origin `fetch(...,{credentials:'include',
headers:{'X-Requested-With':'XMLHttpRequest'}})` or reuse page `$.fn.request`). Gate
behind per-shop flags default OFF + review modal; can't be tested from the isolated
env (no AutoFlow session) — needs a logged-in shop tester. Lock `update_sheet` field
names with one real capture before enabling.

**Built (Task 586), payloads now verified against source JS (Task 590):** all 3
actions ship in `adapters/autoflow-content.js` + MAIN-world
`adapters/autoflow-dvi-bridge.js` (reuses page `$.fn.request`/`$.fn.requestRVH`,
reads `window.defaults`). Payloads were confirmed by fetching AutoFlow's PUBLIC,
un-authed DVI source JS at `https://admin.autotext.me/Admin/dvi_v3/js/...`:
- `update_sheet` lives in `jquery.atme.notes.js`. Real params: `request_type`,
  `status_id`, `sheet_id`, `group_id?`, `recommendation[]`+`rec_sms_code` (notes
  only), plus every popup input by `name` (`inspec_id`, `results_id`,
  `prev_tech_id`, `inspec_status` 0/1/2, `notes`). **`inspec_sub_status` and
  `customer_approval` DO NOT EXIST anywhere in the DVI source** — they were
  dead params (PHP ignores them); removed. `sheet_id` (always sent by the UI)
  was MISSING from our payload; now added (bridge `readDvi` surfaces
  `sheetId` from `defaults.sheet_id`).
- `add_rvh` lives in `jquery.atme.rvh.js`. Real params built from a modal:
  `status_id`, `request_type:"add_rvh"`, `details`, `notes`, `private_notes?`,
  `type` (status select), `mappings[]`, `skip_mapping`. Our guessed fields
  (`details`, `notes`, `skip_mapping:1`) were CORRECT — no change. `type` is the
  severity/category select; its options are fixed in the source JS (no live capture
  needed): **0=Concern (label-warning), 1=Information (label-info), 2=Service
  (label-success)**. We now send it, mapping recommendation status: overdue→0
  (Concern), due-soon→2 (Service), unknown→1 (Information). Omitting it defaults to
  AutoFlow's first option (Concern/0), so every add looked overdue before.

**GOTCHA — `$.fn.requestRVH` never rejects:** unlike `$.fn.request` (which
`dfd.reject(data)` on no-`success`), `$.fn.requestRVH`'s deferred ONLY resolves
when `data['success']` is truthy and otherwise just `alert()`s — it never
resolves OR rejects. So a failed `add_rvh` leaves the page deferred pending
forever; the MAIN-world bridge's `$.when(...).then` never fires. This is bounded
only by the content-script `afBridgeSend` 8s `bridge_timeout`, so failed adds
still get counted (as failures) but ~8s each. Don't assume the page helper will
report errors.

**Still needs a live pilot:** per-shop flags `dvi_prefill`/`enhance_notes` ship
default OFF; a logged-in shop tester must still run all 3 actions end-to-end once
(can't be done from the isolated env — no AutoFlow session). WAR gotcha: button
icons must be listed in the AutoFlow web_accessible_resources block (per-origin),
not just Tekmetric's.
