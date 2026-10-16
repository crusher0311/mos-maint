# Exhausted callback recovery: operator review plan

This is a plan, not authorization or an executable reset. Deploy and verify the
fresh-callback selection correction before attempting retained-history recovery.

## Establish the baseline

- Read the effective shared policy's replay floor; do not use a recent-only
  window or include notifications predating that floor.
- Separate unsupported Contacts, exhausted attempts, and same-object siblings.
  Report unique `(shop, object type, object ID)` identities as well as row counts.
- Confirm new callbacks are actually attempted and completed after deployment;
  repeated `empty` batches alone do not prove that the queue has caught up.
- Sample exhausted outcomes to distinguish provider errors, invalid/missing
  objects, normalization failures, and interrupted local persistence. Fix the
  cause before retrying. Unknown outcomes remain unknown.

## Proposed first recovery batch

Select at most ten reviewed identities from at most two explicitly approved shops.
Use existing provider pacing, relay enforcement and the separate recovery lane;
never enable unrestricted historical imports or raise global retry limits.
Reserve fresh-callback capacity and avoid shop opening/training windows.

Do not implement recovery by setting attempts to zero or replaying older siblings.
Any recovery command must fence the exact current authoritative generation,
retain terminal precedence, and record operator approval, request identity and
outcome. If no existing command provides these guarantees, implement and test it
before performing a production write.

Stop admitting recovery work after ten identities or thirty minutes, whichever
comes first. Pause earlier on a rate-limit response, policy/breaker denial,
ambiguous write, repeated transport failure, or worsening fresh-callback latency.
Allow already admitted work to settle; reconcile ambiguous results before retry.

## Acceptance and expansion

Report processing separately from history indexing: an open-work-order or
missing-VIN outcome is not proof of repaired history. Compare before/after
callback delay and interactive errors. Expand only after the small batch has
durable outcomes and fresh callbacks still progress. Unsupported Contacts and
permanently missing objects require explicit disposition, not silent completion.
