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

**Built (Task 586), still UNVERIFIED live:** all 3 actions ship in
`adapters/autoflow-content.js` + MAIN-world `adapters/autoflow-dvi-bridge.js`
(reuses page `$.fn.request`/`$.fn.requestRVH`, reads `window.defaults`). Writes
were implemented with `update_sheet` (status_id, inspec_id, inspec_status 0/1/2,
inspec_sub_status, results_id, prev_tech_id, notes, customer_approval) and
`add_rvh` (status_id, details, notes, skip_mapping) — but the **add_rvh payload
field names were never confirmed against a real capture** and nothing was tested
from the isolated env (no AutoFlow session). Lock both payloads with one logged-in
shop capture before turning the per-shop flags on. WAR gotcha: button icons must be
listed in the AutoFlow web_accessible_resources block (per-origin), not just Tekmetric's.
