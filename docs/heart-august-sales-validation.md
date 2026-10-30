# HEART August 2026 sales comparison

Read-only validation against the user-supplied August 1–31 enterprise Sales
Details CSV, completed October 30, 2026. Current HEART membership resolved to
nine locations. The export has 4,248 unique location/invoice pairs and
$3,588,472.70 in Total Sales. Export timestamps are CDT.

## Results

| Category | Invoices | Export total |
|---|---:|---:|
| Single located raw copy; all seven financial columns match | 4,243 | $3,587,094.11 |
| Located but financial differences remain | 2 | $155.51 |
| Conflicting retained raw copies | 2 | $1,338.36 |
| Not located through bounded reads | 1 | −$115.28 |

The two single-copy mismatches have export/stored totals of $68.74/$99.90 and
$86.77/$156.78. Other monetary columns differ too. This establishes snapshot
disagreement, not which source should be repaired.

The conflicting-copy invoices each have one raw copy matching the export and
another zero-valued copy. Neither was treated as an unambiguous exact match.
The unlocated negative entry has a linked invoice in the source CSV; it may
represent a credit/refund population rather than an ordinary positive sale.
Do not count it as an unexplained missing tire sale.

## Lookup and coverage

Used normalized indexed invoice identities only as lookup accelerators, then
inspected retained raw Tekmetric invoices. Every initially unresolved or
mismatching invoice also received a direct shop-scoped raw invoice-number search,
without a normalized-record prerequisite. Those queries preserved mixed
string/number shop and invoice representations.

Some direct searches hit their ten-second safety deadlines after returning
matches. Thus, results prove the returned matches, not exhaustive absence or
absence of other duplicate copies.

No nonempty DOT arrays were found in retrieved raw records. This does not certify
that HEART recorded no DOTs in Tekmetric. Raw endpoint completeness, capture
shape and registration evidence remain unverified; keep live rollout on hold.

## Local evidence

Comparison data and CSVs are in the ignored, period-specific directory
`generated-artifacts/heart-tire-dot-validation/2026-08-01_2026-08-31/`.
The delivered `august-reconciliation.csv` contains all 4,248 rows;
`august-exceptions.csv` contains five exceptions. Amount columns explicitly
denote cents. Customer names/contact data are not in these downloads.
October evidence is preserved separately.

Run the parameterized scripts with `2026-08-01 2026-08-31` after preparing a
minimized `export-input.json` in that period directory:
`scripts/reconcile-heart-sales.ts`, then `scripts/verify-heart-raw-unresolved.ts`.
The first script is not a complete population check on its own. Keep duplicate
raw copies and source-coverage warnings when combining outputs.

No provider requests, database writes, schema/index changes, or production
activation were performed.
