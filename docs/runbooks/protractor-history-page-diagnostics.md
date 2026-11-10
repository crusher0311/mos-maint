# History invoice-page rejection diagnostics

## Scope

Local implementation and offline testing only. This change does not authorize
deployment, provider probes or resuming shop 635.

The prior seven-day live attempt returned HTTP 200 but failed page validation.
It did not retain enough evidence to identify the rejection subtype. These
diagnostics cannot retroactively identify that response.

## Event

The date-range fetch emits one `protractor_history_invoice_page_rejected` event
when the collector returns a rejection or incomplete-budget result.

Fields are limited to shop ID, fixed reason, page number, requested offset and
page size, received count, accepted count, and invalid-ID count. Unknown counts
are null. No invoice IDs, customer data, raw payloads, URLs or provider error
messages are included. The old free-text provider error log in this fetch path
is replaced by a fixed request-failure message.

Reasons:

- `missing_item_collection`: collection is absent or undefined.
- `non_array_item_collection`: collection is present but not an array, including null.
- `overfull_page`: array contains more than the requested 25 records.
- `invalid_invoice_id`: at least one record lacks a nonblank string ID.
- `duplicate_invoice_id`: an ID repeats within or across pages.
- `upstream_request_failed`: the transport/client returned `ok:false`; no raw error is copied.
- `invalid_page_budget`: invalid budget, with no dispatch.
- `offset_limit` / `page_budget_exhausted`: incomplete results within unchanged bounds.

Page number is one-based for fetched pages, zero when no request was made.
On a budget/offset stop it identifies the last fetched page; skip is the next
offset that was not fetched. Accepted count describes the collector's retained
records, not committed database writes. Duplicate detection preserves the
existing partial-page retention behavior.

Only the first failing validation is reported (shape before size before IDs).
For example, an overfull response is not also scanned for invalid IDs.

## Safety and verification

Request sizes, budgets, byte caps, cursor decisions, shrink markers and
single-pass behavior are unchanged. No additional provider requests are made.
Successful pages do not emit a rejection event.

Offline paging/loader tests cover exact subtype/count output, partial pages,
duplicate IDs, budget stops, successful responses, and the real logging sink
with synthetic sensitive content. The fleet suite covers disposable Mongo,
admission and admin controls. TypeScript also passed.

This is not a full production build, deployment or fresh provider-contract test.
