# Raw retention correction and offline evidence preview

## Implemented locally

Existing-work-order PostgreSQL updates now receive the same sanitized native
payload as create and Mongo shadow writes. This prevents that update path from
dropping the native payload from the serialized `raw_data` document.

This is current-snapshot retention, not an immutable archive of every version.
An incoming incomplete payload is still the current payload; old invoice hours
are not silently carried forward. The separate identity/date preservation rules
and source-ownership guards remain unchanged.

The regression was first run against the old implementation and failed because
the PostgreSQL update document's raw payload was undefined. It now passes for
create, update and wrapped payloads, checks detached JSON serialization, and
retains the existing identity-conflict and stale-hours checks.

## Offline preview

`scripts/preview-invoice-evidence-local.ts` accepts a local JSON array of:

```json
[
  {
    "shopId": 227,
    "sourceIds": ["the-native-invoice-guid"],
    "copies": [
      {"shopId": 227, "raw": {"ID": "the-native-invoice-guid"}}
    ],
    "existingEvidence": null
  }
]
```

This schema illustration is not a usable invoice fixture. Supply actual
approved local payloads, including invoice headers and regular/deferred labor.
Include all relevant retained copies; the utility cannot discover omitted peers.
No database credentials or provider clients are used.

Run with outbound networking denied and source credentials absent:

```sh
env -i PATH="$PATH" HOME="$HOME" \
  NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
  node --import tsx scripts/preview-invoice-evidence-local.ts LOCAL_CASE_FILE.json
```

Limits: 10 MB input, 1,000 cases, 10 shops and 20 copies per case.
Duplicate review identities reject the entire run. Output contains category
counts and reason counts only, not raw payloads, customer data or invoice IDs.

Categories:

- `complete_candidate`: supplied copies establish identity/date and both hour
  measures; this is not financial corroboration or authorization to write.
- `identity_date_only`: identity/date verified but one or both hour measures
  unavailable; this cannot supply a complete pair of reporting averages.
- `already_present`: existing evidence matches the supplied source evidence.
- `held`: conflicting or missing identity/date/hours, cross-shop copies,
  ambiguous ownership, or differing existing evidence.

Every outcome has `repairAuthorized: false`. No child financial records,
invoice numbers, dates or hours are guessed or repaired.

## Verification and limits

Passed credential-free, network-denied tests for retention, the offline preview,
stored reconciliation and invoice reporting. TypeScript checking passed.
CLI tests cover sanitized output, valid input, duplicate input and malformed
input. Preview classification tests cover complete/incomplete evidence,
cross-shop identities, missing payloads/numbers, conflicting dates and existing
evidence.

No fresh production data was accessed. The retained fleet snapshot contains
metadata, not all native invoice payloads, and the owner-closure file contains
hashed structural references. Therefore no new fleet-wide recoverability counts
are claimed. The preview is ready for a separately approved bounded capture of
stored raw copies. Do not rerun the history importer or contact Protractor.

No deployment, production repair, database permission change or feature
activation was performed. Production runtime permissions and PostgreSQL-version
preflight remain separate release gates for the fleet query.
