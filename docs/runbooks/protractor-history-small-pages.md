# Smaller history invoice pages — local verification

## Scope

Local-only work on `fix/protractor-history-page-size`. No provider requests,
production changes, push, deployment, circuit reset or import resume.
Shop 635 remains paused under the previously confirmed production controls.

## Behavior

- Historical invoice lists request 25 records instead of 100.
- Existing per-pass request count, skip ceiling and physical admission budgets
  remain unchanged. The read-only fleet endpoint gate permits exactly 25 or the
  previously accepted 100; method, date, body and scope restrictions remain.
- Each successful full page advances its offset by the returned record count.
  An exact multiple requires a terminal empty page within the remaining budget.
- An oversized/error response stops the pass without immediate retry. Existing
  transport breaker and response-byte cap are unchanged.
- Malformed collections, missing IDs, repeated/overlapping pages and responses
  larger than requested cannot be mistaken for successful empty history.
- Page-budget exhaustion holds the date cursor and retains the pending-attempt
  marker, allowing the existing next-pass date-window shrink. The prior midpoint
  advancement could not prove that a partial list covered the skipped dates.
- Empty-error chunks now report an error metric rather than the default success.

## Evidence

Offline tests cover offsets and all-record preservation, terminal pages,
request/offset bounds, oversized first and later pages, malformed/duplicate
responses, endpoint restrictions and held-cursor decisions. The canonical empty
and nonempty chunk paths both use the tested cursor policy; source wiring checks
verify that integration. The new paging and loader regressions run in prebuild.

Passed: paging/loader regressions; fleet suite including disposable real Mongo;
Protractor resilience; full onboarding including browser checks; TypeScript;
direct-database and route-authorization guards; whitespace checks.

## Limits and next release

25 is a conservative initial page size, not a measured guarantee that the live
response fits. No adaptive retry that bypasses an open circuit is implemented.
If a page remains too large, its cursor is held and the pass fails safely.
Date-window shrinking retains its existing minimum; a range still exceeding
the budget at that floor remains incomplete rather than being skipped.

A full production release build and separately approved, monitored live trial
are still needed before claiming that this resolves shop 635's actual payload.
Prepare only the new page-handling changes relative to the reviewed production
revision; do not deploy unrelated workspace changes.
