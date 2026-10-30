# Confirmed UI-versus-retained-payload DOT gap

Read-only investigation on October 30, 2026, following a user-provided screenshot.
No customer names, vehicle identifiers, or contact data are retained here.

## Northbrook known-positive screen

- MOS location 37, Tekmetric invoice 853078267, provider RO 360572784.
- Screenshot shows four DOT entries on the BF Goodrich tire line.
- The location-scoped raw cache contains one matching RO document in the
  bounded exact-ID lookup. Its invoice total is 114456 cents, matching the
  August export and the screen.
- Tire job 1265426827 includes BF Goodrich part 1136235163, quantity four.
  The part has tire-specific metadata but **no `dotNumbers` property**.
  This is different from an explicitly empty array.
- Stored fetch/update timestamp: September 2, 2026 at 20:15:15.988 UTC.
  Raw provider updatedDate: September 2 at 20:15:08 UTC.
- No `tekmetric_jobs_cache` document was found for this provider RO.

The screenshot confirms current UI evidence, but does not establish when those
DOT entries were recorded relative to the retained snapshot.

## Historical control rechecked

MOS location 311, invoice 49, provider RO 172586182, posted August 14, 2024.
A bounded raw lookup reconfirmed:

- `["UNK1R7420624", "UNK1R7420624"]`
- `["UNVDR7411924", "UNVDR7411624"]`

Other parts in that payload have explicit empty `dotNumbers` arrays. Therefore,
the historical schema/capture path could retain this field, including repeats.

## Code evidence and limits

The reviewed incremental-sync writer assigns `data: ro` directly from a
repair-order list result. The webhook path similarly assigns
`setFields.data = repairOrder`. These whole-payload replacements do not merge
omitted part fields with older evidence. The reviewed paths did not show an
explicit DOT-field removal.

That establishes a potential overwrite mechanism, **not** proof of the writer
or response responsible for this particular snapshot. Stored fetch timestamps
alone do not establish provenance. No old version of this Northbrook payload
was recovered, and no provider requests were made.

## Next approved diagnostic

Obtain explicit approval for one read-only detailed repair-order fetch, scoped
to Northbrook and provider RO 360572784, with no cache writes, reimports, or
repairs. Compare only the tire part's DOT-field presence and entries:

- Present now: investigate source channel, snapshot freshness and capture loss.
- Absent while UI shows entries: investigate API/endpoint exposure separately.

Do not infer that a present value now proves it existed at snapshot time, or that
an absent value in one endpoint proves all provider APIs omit it.

## Approved single-request result

The user subsequently approved one read-only detailed invoice fetch. On October
30, 2026 at 18:26:48 UTC, one GET to `/api/v1/repair-orders/360572784` returned
the expected provider shop, RO and invoice identities. No token refresh, retry,
database write, source repair or history import was performed.

The BF Goodrich part 1136235163 returned:

```
["15KE7MV112126", "15KE7MV111026", "15KE7MV111026", "15KE7MV111026"]
```

The warranty part returned an explicit empty DOT array. Both corresponding
stored parts omit the `dotNumbers` property entirely.

The detailed response's RO `updatedDate` is September 2, 2026 at 20:15:08 UTC,
the same as the stored snapshot's provider timestamp. Therefore, matching RO
timestamps do not establish equivalent payload completeness. This still does
not prove when part-level DOT values were entered or which writer omitted them.

The result rules out “this detail API cannot expose DOTs” for this invoice and
establishes that the cached payload is insufficient for registration reporting.
The responsible ingestion channel remains to be established. Before enabling the
report, design an approved bounded detail-enrichment path and protect confirmed
DOT evidence from field-omitting updates, while respecting actual corrections
and explicit clears. Existing records require separately approved recovery;
neither automatic re-fetch nor production activation is authorized by this check.

Sanitized part-level comparison is retained in ignored local evidence under
`generated-artifacts/heart-tire-dot-validation/northbrook-known-dot/`.
The diagnostic script has a local exclusive-create attempt marker to prevent
accidental repeated requests. Full upstream responses and credentials are not
persisted.
