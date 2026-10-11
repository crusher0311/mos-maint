# Protractor parts receipt evidence

## Status

Code-path inspection plus live, read-only snapshots across user-confirmed part
addition, ordering and receipt. Partial receipt remains unobserved. The user
accepted closing with a narrower outcome: automatically reflect parts-list
changes, but keep receipt readiness manual. No automatic receipt detection or
provider writes are authorized.

## Accepted outcome

Callbacks plus fetched RO lines support refreshing part identity, descriptions,
quantities and prices, including blank-to-identified lines and removals. They
do not establish ordered/received status. The user accepted requiring a fresh
readiness review when a new part is added to an already-ready job.

That workflow behavior is a separate implementation step, not delivered by this
investigation. Partial-delivery semantics and a separate receipt endpoint remain
unverified; neither is a prerequisite for the agreed manual-readiness approach.
Do not interpret this conclusion as proof that Protractor has no receipt API.

## What the code establishes

- `lib/integrations/protractor/client.ts`: `ProtractorServicePackageLine` models
  `ID`, `Quantity`, `Status`, prices and part identity, but no explicit received
  quantity or receipt timestamp. This is a local type, not proof that Protractor
  omits receipt fields. Inspect full raw responses, not just typed projections.
  `fetchWorkOrderById` reads `/WorkOrder/{id}`.
- `lib/integrations/protractor/callback-drain.ts`: WorkOrder notifications cause
  a detail fetch followed by snapshot storage and normalization. The fetched
  response is the state at fetch time, not necessarily at notification time.
- `lib/integrations/protractor/callback-selection.ts`: replay selection coalesces
  object notifications, prioritizes terminal events, then local receipt time and
  a tie breaker. This is not a provider event sequence or a receipt ledger.
  Multiple changes can be represented by one latest-state fetch.
- `lib/data/repositories/protractor-work-orders.ts`: snapshots are upserts by
  shop and work-order ID. A latest snapshot alone cannot establish a historical
  before/after transition.
- `lib/shop-dispatch/operations.ts`: parts states are `unknown`, `not-needed`,
  `ordered`, `partial`, `received`, `incorrect`. Only `received` and `not-needed`
  satisfy the parts gate. `lib/shop-dispatch/model.ts` records reviewed readiness
  through the readiness command. No receipt mapping is justified by the above.

## Missing evidence and capture protocol

Identify one shop and human RO number with a genuine multi-unit or multi-part
delivery. Obtain the shop's confirmed receipt times (including timezone) and
which quantities were physically received. Historical raw snapshots can be
used if they independently cover all three states; a current response cannot
reconstruct a missing baseline.

1. Capture the raw read-only RO response before receipt, after a partial receipt,
   and after final receipt. Match shop, RO, service-package ID and line ID across
   samples. Retain fetch start/end times and provider modification times.
2. Compare every material-line field, including nested purchasing/inventory
   references. Record exact paths and values for ordered, received, outstanding
   quantities and receipt state **only if observed**. Do not treat `Quantity`,
   generic `Status`, authorization, invoicing, or line presence as arrival.
3. Correlate callback object type/ID, operation, local arrival time and processing
   time with those reads and the shop-confirmed receipt times. Observe whether
   partial and final receipt each trigger a callback; do not infer this from
   unrelated WorkOrder update notifications.
4. Check delayed/duplicate/coalesced notifications and read-after-notification
   lag. Distinguish provider ordering from local arrival ordering. A missing
   callback in a short window is inconclusive.
5. Establish whether quantities mean supplier receipt, inventory availability,
   or allocation to this job. Check multi-line jobs, split deliveries,
   substitutions, returns and canceled/unneeded lines before defining a safe
   job-level readiness rule. Unknown or ambiguous evidence stays manual.

Use bounded, narrowly scoped read-only queries. Do not invoke the callback drain,
replay events, mutate receipts, change readiness, enable a shop, or run app
startup against shared production stores to manufacture evidence. Keep customer
details, credentials and raw sensitive payloads out of committed reports.

## Read-only observation — 2026-10-11

For the user-identified RO, four matching WorkOrder `Update` callbacks arrived
at 11:04:32.181, 11:05:24.000, 11:07:15.695 and 11:08:56.692 UTC.
All four were marked processed; the last completed at 11:09:05.177 UTC.
The cached RO was fetched at 11:09:04.526 UTC. Its oil-change package had a
provider modification time of 11:08:55.020 UTC, consistent with the latest
notification, but this does not identify the specific edit that caused it.

The snapshot contained two material lines: engine oil (quantity 6.13) and an
oil filter (quantity 1), both with earlier line-modification dates. Neither
exposed a received quantity or receipt timestamp. `CoreStatus=Returned` and
inventory IDs were present; neither establishes parts arrival. The newly added
part has not been identified in this snapshot. These reads prove callback
arrival for this RO, not causation by a particular part edit or actual receipt.
No provider API calls or database writes were performed.

The user identified the added filter as part `95465`. A further WorkOrder Update
arrived at 11:10:04.767 UTC and completed at 11:11:05.075 UTC. The refreshed
snapshot (11:11:04.498 UTC) now contains an additional material line with
`PartNumber=""`, `Description="Description"`, `Quantity=1`, and modification time
11:10:03.090 UTC. The two older material lines remain. No `95465` value was found
in the raw cached payload. This establishes a line-addition change across two
observed snapshots and a closely timed callback, but does not identify that
blank line as the user's filter. Its `CoreStatus=Returned` is not receipt proof.
Actual ordering, partial receipt and complete receipt remain unobserved.

At the next user-requested check, another Update callback arrived at
11:11:52.381 UTC and completed at 11:12:04.838 UTC. The snapshot fetched at
11:12:04.267 UTC contains a second distinct new material line, also with a blank
part number, description `Description`, and quantity 1 (modified at
11:11:46.087 UTC). The first blank line and the two original material lines
remain. `95465` is still absent from the raw cached response. This is another
observed line addition, not evidence of receiving either line.

The subsequent snapshot fetched at 11:13:04.960 UTC **does contain `95465`**,
description `Carquest Premium Filters Engine Oil Filter`, quantity 1. Its line
ID matches the second previously blank line; its modification timestamp is
11:12:46.297 UTC. A WorkOrder Update arrived at 11:12:47.779 UTC and completed
at 11:13:05.781 UTC. The first blank line is no longer in the material-line
collection; the original oil and filter remain. This supplies a directly
observed blank-to-identified-part transition correlated with a callback.
No received quantity or receipt timestamp was exposed on this material line.
The user's order/receipt action at this step is not yet confirmed, so this
must not be labeled ordered or received.

After the user explicitly reported placing the order, two further WorkOrder
Update callbacks arrived at 11:15:50.664 and 11:15:53.937 UTC. Both were marked
processed around 11:16:06 UTC; the snapshot was fetched at 11:16:06.169 UTC.
The returned `95465` line's non-personal fields are unchanged from the
11:13:04.960 snapshot, including quantity, cost, inventory IDs, `CoreStatus`,
empty tags/flag, and the earlier line-modification timestamp. This is evidence
of callbacks contemporaneous with user-confirmed ordering, but no distinguishing
ordered status on the fetched line. It does not establish actual receipt,
partial-delivery semantics, or a one-to-one callback-to-action contract.

After the user reported receiving the part, the initial check at 11:17:07 UTC
still showed the pre-receipt snapshot. A bounded recheck at 11:18:17 UTC found a
new WorkOrder Update received at 11:17:23.804 UTC, processed at 11:18:05.882 UTC,
with a refreshed snapshot fetched at 11:18:05.516 UTC. The identified material
line's non-personal fields and modification timestamp remained unchanged from
the pre-order and ordered snapshots. Thus this single user-confirmed receipt
correlates with a callback but exposes no distinguishing receipt state on the
returned RO material line. This does not rule out purchasing/receipt data on
other provider endpoints. Partial receipt and those endpoint contracts remain
unverified; do not automate readiness from this evidence.

## Next required input

A shop and RO with known partial/final receipt times, plus retained before/after
exports if available; alternatively a shop-coordinated upcoming receipt at which
read-only snapshots can be captured. No live data queries or provider calls were
made during the initial code inspection; the later observation above used
read-only Mongo queries.
