# Protractor identity protection and repair preview

## Scope

Local safeguards and a bounded read-only investigation of ten previously
identified mixed-ID parent rows in three JWT shops. No production records,
indexes, settings or provider data were changed. No deployment occurred.

The last fully validated reporting result remains 6,297 invoices, 17 unknown
invoice identities and one invoice with incomplete hours. Ten mixed-ID source
rows do not mean ten distinct unknown invoices.

## Local prevention

Protractor display-number matches are no longer sufficient to join distinct
invoice/work-order GUIDs. Existing mixed identities, unknown identities and
different identities fail explicitly before the parent update or child work.
The same guard applies when lookup falls back to provider identity.

The PostgreSQL writer checks identity atomically on primary-key conflicts.
Protractor secondary-unique-key collisions no longer redirect an incoming write
to a different canonical ID and report success under the losing ID. They
return a conflict so a retry can resolve ownership afresh. Other providers'
existing handling is unchanged. This preserves constraints rather than
removing them or inventing new display numbers.

Mongo shadow updates compare identity fields, not the entire provenance
object: PostgreSQL and Mongo can serialize its timestamps differently.
Mixed shadow identities are not overwritten.

**Rollout consequence:** affected records will stop with an explicit conflict,
not silently merge. This does not repair existing mixed parents or guarantee
uninterrupted ingestion for affected shops. Do not deploy as an automatic
history-repair mechanism.

## Preview findings

The ten parents currently own:

| Child type | Records |
|---|---:|
| Service jobs | 72 |
| Line items | 95 |
| Payments | 10 |
| Total | 177 |

Stored Mongo source copies provisionally assign all 177 child source IDs to one
provider identity each. No unmatched or multi-owner child IDs were found in
this bounded comparison. Each inspected line's existing service-job link
agrees with that provisional assignment.

However, six proposed work-order-number destinations already belong to other
canonical parents whose provider IDs differ. These are additional ownership
conflicts, not evidence that those destination rows should be overwritten.

Therefore every preview remains **hold / no executable write plan**. The next
repair investigation must resolve those destination owners, verify archived
final payloads and all other referencing entities, then simulate parent/child
changes in a disposable database and rerun the actual report. No financial
values, IDs or dependencies should be guessed from totals or dates. Source
reads are not an atomic snapshot across PostgreSQL and Mongo.

## Reproduction and checks

- Read-only preview:
  `node --import tsx scripts/trace-invoice-identity-links.ts --repair-preview`
- Real disposable PostgreSQL identity/concurrency checks:
  `bash tests/run-protractor-work-order-identity.sh`
- Existing invoice-preservation, callback-normalization and PG canonical
  skip-path regressions passed.
- Type checking, extension-policy lint, direct-database lint and whitespace
  checks passed.

The preview script emits hashed identifiers and numbers rather than raw
customer data. Tests run against a marked disposable loopback database.
No signed-in UI or live provider writes were exercised.
