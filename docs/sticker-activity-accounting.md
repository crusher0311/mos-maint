# Sticker activity and estimated rolls

Historical `sticker_generations` rows remain unchanged. Rows without evidence
are approximate generation evidence, not proof that a physical label printed.
Older clients keep this behavior and do not consume roll estimates.

Updated clients send one random `printActionId` per deliberate print and reuse
it through fallback/transport retries. Successful print-intent rendering records
a browser/PDF handoff estimate, not a printer acknowledgment. Failed render/PDF
conversion, settings samples, and queue image preparation do not record activity.
Queue requests with an action ID enqueue once and record only successful agent
acknowledgment. Basic extension sessions continue to suppress sticker telemetry.

New event identities hash the authenticated shop and action. A Mongo transaction
inserts the event and increments the opted-in roll together. The built-in `_id`
index is sufficient for correctness; no index installation is performed.
Roll setup/reset uses a revision compare-and-set; roll changes serialize with
consumption writes. Roll state is separate from copied sticker branding.

The seven-day badge is an outreach hint, not proof of physical inactivity.
No history plus a known creation/activation date receives seven elapsed days
of grace. Unknown history or failed summary reads never qualifies. Canceled
shops and shops without the sticker feature do not qualify. Legacy timestamps
are labeled approximate; existing review/email flags are independent.

Local verification must use the isolated replica fixture and egress guard:

```
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' node --import tsx --test tests/sticker-activity.test.ts
```

No deployment, production writes, historical repair, backfill, or production
index creation is authorized by this change.
