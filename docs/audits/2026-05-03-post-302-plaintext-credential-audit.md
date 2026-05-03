# Post-#302 Plaintext Credential Audit

- **Date:** 2026-05-03
- **Task:** #307 (follow-up to #302)
- **Type:** Read-only sanity check. No rows modified, no schema changes,
  no emails sent.

## Scope and data sources

Both production auth routes read credentials from the same MongoDB
collection (`users` in database `mos-maintenance-mvp`):

- `app/api/extension/auth/route.ts` — calls `db.collection("users")`
  via `getDb()` (lib/mongo.ts).
- `app/api/auth/login/route.ts` — calls `db.collection("users")`
  via the same `getDb()`.

Because both routes share one source of truth, the audit was run once
against `users` and covers both login surfaces. Both routes compare
the candidate password against the `passwordHash` field (bcrypt or
legacy scrypt). Neither route reads the legacy `password` field.

## Bucketing rule

For each row in `users`, the `passwordHash` field was placed in
exactly one bucket:

| Bucket               | Definition                                                                           |
| -------------------- | ------------------------------------------------------------------------------------ |
| `bcrypt-valid`       | string matching `^\$2[aby]\$` AND length 60                                          |
| `empty / null`       | field missing, `null`, or `""`                                                       |
| `scrypt-shaped`      | string starting with `scrypt:` (legacy, login route auto-upgrades on next sign-in)   |
| `other`              | anything else (post-#302 this should be 0)                                           |

The `mustChangePassword: true` flag was counted separately — it is a
status flag from the #302 force-reset path, not a hash shape.

## Results

Total user rows: **109**

| Bucket                                                       | Count |
| ------------------------------------------------------------ | ----: |
| bcrypt-valid (`$2a/$2b/$2y`, length 60)                      | 103   |
| empty / null / missing `passwordHash`                        | 6     |
| scrypt-shaped `passwordHash`                                 | 0     |
| **other** (non-bcrypt, non-scrypt, non-empty)                | **0** ✅ |
| non-bcrypt rows flagged `mustChangePassword: true`           | **0** |
| `mustChangePassword: true` flag set on any row (global, status flag) | 27 |
| rows with a non-empty legacy `password` field                | 4     |

The "other" bucket — the one #302 was supposed to drain — is **0**.
No spot-check rows to capture.

### Per-shop breakdown of the 6 non-bcrypt rows

| shopId | count | empty/null/missing | scrypt | mustChangePassword |
| -----: | ----: | -----------------: | -----: | -----------------: |
| 0      | 1     | 1                  | 0      | 0                  |
| 73     | 1     | 1                  | 0      | 0                  |
| 74     | 1     | 1                  | 0      | 0                  |
| 75     | 1     | 1                  | 0      | 0                  |
| 76     | 1     | 1                  | 0      | 0                  |
| 77     | 1     | 1                  | 0      | 0                  |

All six are admin rows whose `passwordHash` is simply absent. They
fail the login-route check (`looksLikeBcrypt(dbHash)` is false, so
`passOk` stays false) and would receive `Invalid credentials`. None
of them are exposing a plaintext credential.

### Spot-check of the 4 rows still carrying a legacy `password` field

These are the only rows where a string credential lives outside
`passwordHash`. Captured here for the record (read-only):

User emails and `_id`s are intentionally redacted from this committed
report; the on-call engineer working follow-up #308 can re-derive them
by re-running the audit query (`{ password: { $exists: true, $ne: null,
$nin: [""] } }` on `users`).

| row | shopId | role  | created_at               | `password` prefix | `password` length | bcrypt-shaped? |
| --- | -----: | ----- | ------------------------ | ----------------- | ----------------: | -------------- |
| 1   | 0      | admin | 2025-12-24T17:59:31.783Z | `$2b$12$`         | 60                | yes            |
| 2   | 73     | admin | 2026-02-13T14:14:00.861Z | `$2b$10$`         | 60                | yes            |
| 3   | 76     | admin | 2026-02-13T16:44:28.403Z | `$2b$10$`         | 60                | yes            |
| 4   | 77     | admin | 2026-02-26T13:21:23.513Z | `$2b$10$`         | 60                | yes            |

All four `password` values are bcrypt-shaped (`$2b$`, length 60),
**not plaintext**. Neither auth route compares against `password`,
so these admin users are effectively locked out of normal login but
no plaintext credential is exposed. The hashes are sitting under
the wrong field name (`password` instead of `passwordHash`) — most
likely seed/provisioning rows that #302's backfill didn't migrate
because it keyed off `passwordHash`. Three of them were created
*after* #302, which suggests at least one signup/provisioning path
is still writing the old field name.

These 4 rows overlap with the 6 empty-`passwordHash` rows above
(same _ids for shopIds 0, 73, 76, 77).

## Conclusion

#302 succeeded for the bucket it was scoped to: zero plaintext
credentials remain in the user table, and the "other" bucket the
audit was asked to verify is **0**. The only oddities surfaced are
operational, not security:

1. 4 admin rows have their bcrypt hash filed under `password` instead
   of `passwordHash` (cannot log in; not plaintext).
2. 6 admin rows have no `passwordHash` at all (cannot log in).

Both are tracked as follow-up tasks (#308, #309) rather than fixed
here, since this task was scoped strictly read-only.
