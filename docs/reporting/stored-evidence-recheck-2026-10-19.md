# Stored-evidence recheck

This is a local audit of the committed, sanitized evidence review, not a new
production snapshot or an execution of the fleet report.

## Checks completed

- The approved corroboration document still matches its recorded SHA-256.
- All 329 child references are unique and bound to the expected 36 owners.
- Per-owner child counts reconcile with 136 service jobs, 169 line items and
  24 payments.
- Saved counts reconcile: 219 stored/source mismatches and 24 conflicting
  children across nine owners. These are different categories, not sums of
  invoice counts.
- One owner passes its own evidence checks; none is repair-authorized.
  Its retained invoice date is February 13, outside the requested September
  18–October 17 period.

These checks establish internal consistency of the saved review, not accounting
authority or current production coverage. Financial conflicts and independent
identity/date/missingness vetoes remain held.

## Remaining input gap

The temporary raw owner closure and full-fleet snapshot used by the earlier
validation are no longer available in the inspected local temporary workspace.
The sanitized review preserves findings but is not a full raw dataset from
which the report can be rerun. This does not imply loss of the production
records; no live source was checked during this recheck.

A bounded read-only recapture of already-stored PostgreSQL/Mongo records is the
next prerequisite for fresh local verification. It must use the existing capture
limits, explicit shop scope, timeouts and source-integrity checks. This document
does not authorize that recapture, provider calls, repairs, deployment or feature
activation. Do not substitute previously saved unknown counts for current
coverage or treat the passing application tests as verified report numbers.
