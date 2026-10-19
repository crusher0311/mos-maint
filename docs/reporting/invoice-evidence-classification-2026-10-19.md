# Local invoice-evidence classification

## Scope

Analyzed the retained October 19 snapshot only: 215,655 stored work-order rows
across ten JWT shops. No production reads, provider calls, deployments, repairs
or configuration changes were made. The source capture's original failed
validation status remains unchanged; this is a separate successful local analysis.

The local database was restored on a Unix socket with outbound networking denied
and source credentials removed. Analysis used read-only transactions and the
existing resource guards. Total rows and mutually exclusive evidence buckets
were checked with assertions. The exact fleet report was also executed locally.

## Findings

| Evidence category | Stored rows |
|---|---:|
| `invoiceHours` key absent | 215,003 |
| `invoiceHours` explicitly null | 652 |
| Non-null `invoiceHours` evidence | 0 |
| Protractor invoice-ID alias present | 215,655 |
| Work-order-ID alias present | 0 |
| Soft-deleted rows | 0 |
| Closed records left as unknown invoice population | 209,889 |
| Other statuses excluded by the report's uninvoiced policy | 5,766 |

All captured rows identify Protractor as their source. Having an invoice-ID
alias is not sufficient proof of a posted invoice: even the captured draft and
scheduled records have that alias. A closed status likewise does not establish
the required native invoice identity, canonical invoice date and hours evidence.

No malformed populated `invoiceHours` object caused this result: there are no
populated objects to validate. The immediate gap is absent or null reporting
evidence, not rejection of populated evidence by the validator.

### Location breakdown

MOS shop IDs below are internal location identifiers, not JWT store numbers.

| MOS shop | Stored rows | Evidence absent | Evidence null | Unknown invoice population |
|---|---:|---:|---:|---:|
| 227 | 19,479 | 19,433 | 46 | 18,984 |
| 228 | 23,669 | 23,583 | 86 | 22,970 |
| 229 | 25,040 | 24,971 | 69 | 24,465 |
| 230 | 24,677 | 24,602 | 75 | 24,112 |
| 231 | 26,235 | 26,146 | 89 | 25,398 |
| 232 | 19,538 | 19,472 | 66 | 18,985 |
| 233 | 34,926 | 34,850 | 76 | 33,956 |
| 234 | 14,409 | 14,359 | 50 | 14,012 |
| 235 | 17,340 | 17,286 | 54 | 16,947 |
| 236 | 10,342 | 10,301 | 41 | 10,060 |

Every location has zero non-null invoice-evidence objects. The exact report
returns zero verified eligible invoices and null averages, not a meaningful zero
sales or zero hours result. Unknown records cannot safely be excluded by the
requested September 18–October 17 date range because their invoice dates have
not been verified.

## Other retained metadata

`laborReporting` occurs on 1,481 rows: 1,311 objects and 170 explicit nulls.
All 1,311 objects expose `version`, `net`, `sold` and `presented` keys. This
classification checked their structure, not the correctness of their financial
values or completeness of deferred work. Those fields alone do not establish
invoice identity/date or replace the existing financial-evidence review.

## What this does not establish

The fleet snapshot contains reporting metadata, not full raw Protractor payloads
for all records. It cannot prove that raw evidence is missing from the actual
stored source archives, nor establish why metadata was absent or cleared.
It also cannot resolve the held owner/financial conflicts or authorize repair.

The local query performance issue has been resolved separately. Production
database permissions and target-version preflight remain release gates.

## Recommended next step

Trace the local stored-payload-to-reporting-evidence code path, including the
preservation fix and null-producing conditions. Identify which native fields
would allow evidence reconstruction from existing stored payloads, and produce
a bounded repair-preview plan. Only then request any additional read-only
stored-payload sample needed; do not start a new provider import or infer invoice
dates from closed dates.
