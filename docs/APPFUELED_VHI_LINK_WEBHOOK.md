# AppFueled incoming VHI link webhook — implementation / QA handoff

**No deployment, database migration, live credential setup or real notification
submission is performed by this change.** Sample values below are fixtures, not
authorized configuration.

## Native contract

After the operator completes setup, send `POST https://qa.mos.tools/api/external/v1/vhi/links`
with `Content-Type: application/json` and exactly:

```json
{"data":{"event_name":"vhi_url","connection_id":"conn_HSw0db9BqKmG","mos_shop_id":29,"vin":"1FTYR14U15PA88986","vhi_url":"https://shop.example.com/v/xyz789"}}
```

No X-API-Key, signature, delivery ID, upstream-provider mapping or separate
enrollment flag is required. AppFueled's registered connection ID is the agreed
authentication credential; handle it as a secret. The connection determines the
MOS shop, and the integer `mos_shop_id` must match. The shop must still exist and
have maintenance entitlement. API key and API secret are retained securely for
configuration only; no AppFueled API is called.

Native envelopes reject extra/missing fields and wrong event names. Maximum
JSON body is 8192 bytes (enforced while streaming, not just via Content-Length).
VINs normalize to uppercase and must have 17 valid VIN characters. URL maximum
is 4096 characters; only HTTPS, no embedded credentials, IP literals,
localhost/local/internal hosts. URLs are parsed/canonicalized, not fetched or
DNS-verified. A public-looking hostname does not prove that a report is reachable.

An optional `X-Request-Id` or `X-Correlation-Id` may contain 1–128 letters, digits,
dots, underscores, colons or hyphens; otherwise the server generates a request ID.
Native responses carry `X-Request-Id` and `Cache-Control: no-store`.

## Response behavior

- **200**: `{success:true,requestId,shopId,vin,deliveryId,duplicate}` after a
  majority-acknowledged durable inbox insert or verified identical existing row.
  Native `deliveryId` is server-derived, not a source event ID.
- **400**: malformed JSON, invalid envelope/event/VIN/URL/shop field.
- **401**: unknown or disabled connection (same response for both).
- **403**: connection/shop mismatch or maintenance denied.
- **404**: registered shop no longer exists.
- **413 / 415**: oversized body / wrong Content-Type.
- **429**: abuse limit; `Retry-After: 60`. Atomic PostgreSQL minute buckets allow
  3000 total receiver requests/minute and 300 native requests/minute per
  registered shop. Global admission includes malformed/unknown requests and
  legacy requests; legacy partner-key limits also remain in effect.
- **503**: native dependency or persistence failure; safe generic error only.
  Retry after backoff. Never treat a timeout as proof that no insert occurred.

Unknown/malformed native connections never fall back to partner-key auth, even
when a valid partner key is supplied. Other external endpoints are unchanged.

## Durable receipt and duplicate semantics

The existing Mongo `partner_vhi_links` inbox remains authoritative. Native
delivery identity hashes the connection digest, MOS shop, normalized VIN and
canonical URL, with a versioned native namespace separate from legacy IDs.
The collection's built-in unique `_id` index arbitrates concurrent duplicates.
Rows include partner/shop/VIN, URL, server receipt time and non-sensitive native
event/deduplication provenance; no connection ID, API key or secret is stored in
the inbox. Changed URLs create new receipts, including when received concurrently.

Identical resends cannot be distinguished from a later identical event. An
A→B→A sequence leaves the original A receipt and B receipt; the last A is a
duplicate, not evidence that A is the newest source report. AppFueled supplies
no source timestamp, sequence or delivery identity. Receipt time is **not**
source ordering; do not select “latest source report” based on these receipts.
Replacing API credentials while keeping the same connection preserves dedup;
changing the connection ID starts a distinct dedup scope.

No URL fetch, VHI generation, CARFAX request, QR redirect change or recovery job
is triggered.

## Operator setup order (separate authorized deployment work)

1. On the intended environment's canonical PostgreSQL database, apply the
   additive `drizzle/0038_appfueled_connections.sql` before serving this code.
   It adds `appfueled_connections`, its unique connection-hash index and
   `appfueled_webhook_limits`. It is also registered in
   `scripts/apply-normalized-migration.ts`; do not run that broad script blindly
   against a shared database. No Mongo index migration is required for the inbox.
   No shops foreign key is added because deployments can use Mongo-canonical shops.
2. Provision **APPFUELED_CREDENTIALS_ENCRYPTION_KEY** via the environment's secret
   manager: exactly 64 hexadecimal characters encoding 32 random bytes. Use a
   dedicated key, not an API/session secret. No fallback exists. Back it up
   securely alongside encrypted database backups. Do not rotate it casually:
   existing ciphertext must be re-encrypted or all configured key/secret pairs
   replaced under the new key. Encryption is AES-256-GCM with random nonce,
   authentication tag, version and shop-bound authenticated data.
3. Deploy via the separately approved release process. The route retains its
   existing middleware exemption for `/api/external/`; authentication remains
   at the route boundary. Explicit native wrapper recognition is included in
   the route-auth guard.
4. A platform admin opens **Partner API Keys → AppFueled per-store connections**,
   enters an existing MOS shop ID and loads status, then supplies all three
   credentials from AppFueled's secure channel. Saving creates/replaces and
   enables the connection; no provider identity is needed. Verify maintenance
   access separately using existing entitlement administration.
5. Replacement is atomic for one shop; a connection hash is unique even when
   disabled. Disabling retains credentials and audit metadata but rejects new
   native notifications. To re-enable, replace all three fields. Replacing a
   connection ID releases the old identity; only the new one authenticates.

API key/secret are encrypted at rest; the connection ID is stored only as a
domain-separated SHA-256 lookup digest. AppFueled must supply opaque,
unpredictable connection IDs; hashing does not add entropy to guessed values.
Admin APIs return configured/active state and timestamps only, never plaintext,
ciphertext, connection digests or credential suffixes. Creation/update/disable
actor and time are stored on the credential record. This is current-state audit
metadata, not an append-only history of every rotation. Restrict database and
backup access; redact request bodies in any external proxy/APM logging.

Admin API: GET `?shopId=29`, PUT `{shopId,apiKey,apiSecret,connectionId}`,
PATCH `{shopId,isActive:false}` at `/api/platform-admin/appfueled-connections`.
All require a platform-admin session and return no-store responses; duplicate
assignment returns 409. Missing encryption/schema/dependency setup returns 503.

## Legacy compatibility

Existing clients may still send the flat shape:

```json
{"shopId":29,"vin":"1FTYR14U15PA88986","deliveryId":"report-123","vhiUrl":"https://shop.example.com/v/xyz789"}
```

They must authenticate with an AppFueled partner API key via `X-API-Key` or
`Authorization: Bearer`, with `vhi:write` permission. CARFAX-only compatibility
keys do not gain write permission. Flat clients do not need per-store native
credentials. Missing/invalid key is 401; wrong partner/permission is 403.
Identical deliveries return 200/duplicate; reusing a deliveryId with another URL
within the same partner/shop/VIN returns 409. Use a new delivery ID for a new URL.

## Offline mock verification (safe before deployment)

```sh
NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
  npx tsx --test tests/appfueled-vhi-link-webhook.test.ts \
  tests/appfueled-native-webhook.test.ts tests/appfueled-connections.test.ts
npm run typecheck
node scripts/check-unauthed-routes.cjs
node scripts/test-check-unauthed-routes.cjs
```

All webhook/credential tests inject in-memory stores and use synthetic secrets;
they do not submit to QA or connect to shared databases. Repository tests model
unique-index arbitration; the actual SQL constraint still needs validation on a
separately provisioned disposable PostgreSQL instance before rollout.

The offline browser fixture `/appfueled.html` on the existing Shop Workflow
offline checks server mounts the real credential component with blocked network
and synthetic responses. It is test-only, not an application auth bypass.
Generate styles with `node tests/shop-dispatch-browser/appfueled-style.cjs`.
Run `DEMO_CHROMIUM_PATH=$(command -v chromium) node tests/shop-dispatch-browser/appfueled-check.cjs` for configure,
replacement, disable, cancellation and shop-switch clearing checks.

For subsequently authorized QA testing, provision **test-only** credentials and
an eligible test shop, substitute them into the exact envelope above, and verify
first receipt, identical retry, changed URL, mismatch, disabled and unknown
connection responses. Test legacy authentication independently. Do not use the
sample connection as a real credential or send fixtures to live shops.

### Verification performed

- Isolated API/repository tests: passed, using only injected stores.
- `npm run typecheck`, route-auth scanner and its invocation/import-only
  fixtures, and `npm run test:route-entrypoints`: passed.
- Offline browser configure/replace/disable/cancel/shop-switch clearing and
  mobile overflow checks: passed; initial component screenshot inspected.
  The signed-in application page itself was not exercised against a live session.
- Next production **compile-mode** build: passed in a `/tmp` source copy with
  no environment files and an empty inherited environment. This does not
  substitute for deployment or live migration verification.
