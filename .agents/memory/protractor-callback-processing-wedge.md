---
name: Protractor callback processing wedge
description: Webhooks can arrive fine while the follow-up fetch silently never runs — attempts=0, zero error logs; how to detect and un-stick it
---

Webhook receipt and webhook processing are separate failure domains. `protractor_callback_events` rows can pour in (receipt healthy) while the inline `processCallbackEvent` fetch never completes: rows sit `processed:false, attempts:0, no lastError`, and there are NO error/retry/rate-limit log lines at all — the request wedges inside the in-process `pLimit(3)` background concurrency pool in `lib/integrations/protractor/client.ts` before any logging point.

**Why:** July 21–22 2026: fleet-wide Protractor API calls collapsed to ~0/hr for ~23h (api_usage: s200 16k/hr → 5/hr at 19:00 UTC Jul 21, self-recovered ~18:00 UTC Jul 22 with no deploy). ~50k events/day piled up unprocessed. Shops saw "Protractor data not updating" though webhooks were verified arriving.

**How to detect:** compare `received/day` vs `processed/day` on protractor_callback_events, and `api_usage` hourly s200 counts for provider protractor. `attempts:0` + no `lastError` = never attempted (wedge), not fetch failure.

**How to un-stick a shop:** replay distinct stuck objectIds through prod's own handler: `GET /api/callbacks/protractor?connectionId=…&type=WorkOrder&id=…&operation=Update` (param names are exactly `connectionId`,`type`,`id`,`operation` — PascalCase params silently no-op with a usage response). Each replay can take ~15–30s when the lane is congested; run resumable chunks. Replays insert NEW event rows; old rows stay unprocessed (cosmetic).

Note: the protractor-sync pre-sweep queue drain works oldest-first through the ~500k historical unprocessed backlog, so fresh events are effectively never retried by cron — inline processing is the only real-time path.
