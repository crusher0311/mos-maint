# Operator history-import stall monitoring

The existing `/api/cron/pipeline-stall-alerter` monitors the operator-approved
weekend history campaign alongside its existing fleet, drain, and queue checks.
It uses the existing `PIPELINE_STALL_WINDOW_MS` (default three hours), scheduling,
ops notification channels, email recipients, and breach-set deduplication.
There is no new paging job or import admission path.

## Signals

The runner records separate campaign metadata timestamps:

- `heartbeatAt`: lease renewal, not data progress.
- `heldDayAdvanceAt`: a failed day moved into held work, not data progress.
- `capturedPageAt`: upstream data archived, not data progress.
- `verifiedPresentAt`: a new receipt verified an existing invoice and its
  required job index.
- `importedInvoiceAt`: a receipt reached imported after all ingestion checks.
- `completedPageAt`: the runner completed a checked page with no unresolved
  items, including a legitimately empty page.

Only the last three reset the stall clock. Legacy `lastProgressAt`, cursor
movement, repeated receipt reads and retry delays do not. Persisting the
metadata follows the durable receipt/page operation; it does not replace it.

## Eligibility and waits

Monitoring requires the known campaign's validated grant, matching run/owner/
canary generation, live runner leases, running non-stopped campaign, active
authorization dates and intact fleet protection. A stopped *dispatch grant*
alone is expected between requests and during cooldown; it is not cancellation.
Expired, canceled, completed, paused and needs-attention campaigns cannot page.

Fresh callback-priority waits suppress campaign alerts only when the loop is
blocked by callback activity/evidence, not local retry errors. Wait metadata
expires after two minutes unless renewed. The next eligible monitoring window
starts after an observed callback wait; the recorded last real progress remains
unchanged. New monitor state also gets a full observation window, so deploying
monitoring does not immediately page on legacy timestamps.

The health response and notifications include the fixed campaign identifier and
signal times, not archived pages, invoice IDs, customer payloads, raw errors,
bindings, or credentials. Reads are by exact campaign/rate-state keys with
metadata projections; they do not scan receipt or page payload collections.

## Offline verification

```
node_modules/.bin/tsx tests/operator-history-health.smoke.ts
node_modules/.bin/tsx tests/pipeline-stall-alerter.smoke.ts
node_modules/.bin/tsx tests/protractor-weekend-scheduling.smoke.ts
npm run typecheck
```

These checks do not authorize a new campaign, extend the expired weekend
permission, change limits, create indexes, or start imports. Other one-off
history runners have separate authorization contracts and are not implicitly
enrolled by this weekend-specific monitor.
