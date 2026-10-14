# Invoice hours dashboard evidence contract

These are new metrics, not renamed closed-RO measures. Their metric keys and
dashboard definition identity are distinct in the existing content-addressed
run cache; older labor results cannot satisfy an invoice dashboard request.
Saved definitions, version pinning, recipients, delivery and legacy formulas
are unchanged.

## Population and dates

The only initially supported source is Protractor. A verified invoice needs a
source GUID matching the normalized record's Protractor source identity,
final Invoice workflow stage, accepted final status, a positive invoice number,
and an explicit valid InvoiceTime. Type can be Invoice or WorkOrder. Neither an
invoice_id provenance label nor a terminal normalized status is proof on its
own: normalization historically assigned that label broadly and used fallback
modification timestamps as close dates.

Zero-number WorkOrder snapshots can be real invoices but require independent
native evidence not available to this dashboard. They remain unverified, as do
separate credit documents and unsupported providers. This is conservative
availability, not a claim that those invoices do not exist.

The adapter adds a versioned evidence snapshot on ordinary normalization. For
older records, bounded read-only canonical cache recovery can supply matching
raw source evidence. No provider requests, repairs, migrations or imports occur.
An unmatched/current/open cache snapshot is not substituted as a historical
invoice. Existing stored evidence takes priority.

InvoiceTime, never close/completed/modified timestamps, selects the period.
Offset timestamps convert to UTC; offset-less provider timestamps explicitly
mean UTC, matching existing reporting semantics. Controls select inclusive UTC
calendar days. This is not a local shop-day report.

The query scans at most 100,001 authorized nondeleted/nonvoid headers under the
existing absolute query/statement deadlines and fails above 100,000. It cannot
use close-date partitions: doing so loses differently dated invoices and hides
unknown dates. Cache recovery gets at most eight seconds of that same deadline.
Unverified terminal records are disclosed even when fallback dates lie outside
the requested period; they cannot safely be period-filtered. Open uninvoiced
records do not enter the denominator. Coverage means stored evidence only,
never a guarantee of complete imported source history.

## Hours, deduplication and corrections

Both measures share the distinct (shop, provider invoice GUID) denominator.
Duplicate normalized representations count once. Conflicting duplicate dates
create population uncertainty; conflicting hours make the corresponding
numerator unavailable. No arbitrary "last row wins" rule resolves conflicts.
Missing-evidence copies are reconciled against verified identities within the
same shop and provider, independent of input order. Known uninvoiced open or
estimate work is excluded for every provider. Conflicting invoice dates remain
uncertain and do not enter the eligible count on an arbitrarily selected date.
Invoice-average cache keys carry a population revision so earlier incomplete
results are not reused; legacy report cache keys and pinned definitions remain unchanged.

Package GUIDs deduplicate regular/deferred twins; deferred membership wins,
using the existing canonical package merge. Contradictory recorded package or
line hours are detected across raw copies before that merge can overwrite them;
affected numerator coverage is unavailable, independent of source ordering.
Missing package identity prevents
a claim of complete hours. Explicit line IDs deduplicate repeated lines and
conflicting repetitions are unavailable. Draft and explicitly non-invoicing
work is excluded. Estimated-only hours are not sold. Explicit empty collections
can establish genuine zero-hour invoices. Missing collections are not empty.
Sold coverage does not depend on complete declined-work evidence; presented
coverage does.

Same-invoice corrections replace the versioned source snapshot and keep one
invoice, on its invoice date. Separate credits remain unverified rather than
inventing signed labor hours from signed dollar totals. Payment refunds do not
subtract hours. Legacy signed-money and closed-RO measures are unchanged.

Aggregation retains full numeric precision until display. Complete enterprise
averages divide combined hours by combined invoices, not location averages.
Any missing numerator evidence produces a null average with covered/eligible
counts. Population uncertainty independently prevents an average even with
complete known-invoice hours. Zero eligible invoices yields no data.

## Isolated verification

- `npm run test:invoice-hours`: evidence, formulas, coverage, authorized filter
  pushdown and UI totals, with external network denied.
- `npm run test:report-runs:execution`: disposable local PostgreSQL, real invoice
  query plus existing persistence, authorization, retries and stale results.
- `npm run test:custom-reports`: saved definitions and delivery compatibility.
- `node tests/shop-dispatch-browser/invoice-hours-style.cjs` compiles the actual
  reporting classes into ignored generated output for the offline Vite fixture.
  With the existing Shop Workflow offline checks server on port 24100:
  `DEMO_CHROMIUM_PATH=$(which chromium) node tests/shop-dispatch-browser/invoice-hours.cjs`
  and the existing `reporting.cjs` check. The fixture replaces all API calls;
  it never boots Next or opens application database connections.
