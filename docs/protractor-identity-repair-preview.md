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

## Destination-owner closure and local structural simulation

The six destination collisions were followed recursively through stored
PostgreSQL records and indexed Mongo source copies. The bounded graph expanded
from ten original mixed parents to **26 stored parents representing 36 distinct
provider identities** (10 parents in shop 227, six in 229, ten in 230).

Within that graph every provider identity has one evidenced work-order number,
and no two provider identities claim the same proposed number. All 329 child
records have provisional source-identity matches:

| Child type | Records |
|---|---:|
| Service jobs | 136 |
| Line items | 169 |
| Payments | 24 |

No inspected line disagrees with its job's owner. An additional bounded lookup
found no lines outside the captured parent graph referencing its jobs.
The database's declared inbound parent foreign keys are the three inspected
child tables. This does not establish coverage of implicit references in other
stores or application features.

A disposable PostgreSQL structural model passed:

- Retain representations of all 26 original parents.
- Model 36 distinct proposed parents with a unique shop/work-order-number key.
- Assign every existing child identity once, with valid parent and composite
  line-to-job/owner foreign keys.
- Preserve all 329 child fingerprints; no missing, duplicated or altered
  child fingerprints.
- Reject unknown owners, conflicting numbers, cross-shop assignments,
  missing jobs and line/job ownership disagreements.

The simulation uses sanitized identity/number hashes and child fingerprints,
**not reconstructed production financial rows**. Therefore it does not prove
the invoice-hours calculations, rebuild normalized parent totals, or verify the
reporting screen. The structural destination blocker is resolved in this model;
there is still no approved executable production repair.

Reproduction:

1. Run the ten-parent read-only preview above.
2. `node --import tsx scripts/preview-invoice-owner-closure.ts`
3. Run `scripts/simulate-invoice-owner-repair.ts <port>` against a newly created
   disposable loopback PostgreSQL database marked `invoice_preview.disposable=yes`.
4. Pure rejection checks:
   `node --import tsx tests/invoice-owner-repair-model.smoke.ts`

Type checking and whitespace validation passed. Production writes and provider
requests remained zero. The last full reporting result is unchanged: 17 unknown
identities and one incomplete invoice. Next is rebuilding verified invoice
evidence from stored final captures in a local repair simulation, followed by
the actual report SQL; production application and deployment remain separate.
