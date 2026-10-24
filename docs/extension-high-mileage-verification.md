# High-mileage sticker detection

Tekmetric and Shop-Ware previously dropped DOM odometer readings at
1,000,000 miles. Their labeled and mileage-selector extraction paths now
accept readings through **2,000,000 inclusive**, matching the existing sticker
server limit. AutoFlow's text, selector, and labeled-input paths use that same
inclusive ceiling. Existing source precedence and low-mileage thresholds remain.
No maintenance/VHI policy or server mileage limit was changed.

The adapters reject negative readings, decimal or alphanumeric tokens,
malformed comma grouping, missing values, and values over the ceiling rather
than extracting a plausible substring. Unlabeled page numbers are not mileage.
The server still rejects a computed next-service mileage over 2,000,000.

## Offline verification

Run from the repository root:

```sh
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
  node --import tsx tests/extension-high-mileage.smoke.ts
node --import tsx tests/sticker-mileage-coercion.smoke.ts
node --import tsx tests/autoflow-v4-context.smoke.ts
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
  node --import tsx tests/extension-sticker-messages.smoke.ts
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
  node --import tsx tests/shopware-sticker-location.smoke.ts
```

The high-mileage fixture executes the actual context detectors, print-click
senders, background immediate-print handler, and server arithmetic/overflow
block with mocked transport and config. It covers ordinary mileage, both
comma-formatted and plain seven-digit mileage, the old million-mile boundary,
the inclusive ceiling, malformed/unrelated numbers, default/custom intervals,
and source precedence. Existing message tests cover the customization panel.
Before the adapter edits, the same fixture failed at Tekmetric's million-mile
boundary; corrected fixtures produce **1,305,000** from **1,300,000 + 5,000**.

These are isolated DOM/Chrome fixtures, not a reproduction on the reporting
user's live provider page or a physical-printer test. The user's provider is
unconfirmed. No live stores or provider APIs were used.

## Delivery

These are extension content-script changes, not a server-only fix. After the
changes are merged, an updated extension must be installed (or the unpacked
extension reloaded), and already-open provider tabs must be refreshed so they
run the corrected scripts. The manifest version is bumped to 1.35.7 as required
by the repository's extension-change check. No packaging, Chrome Web Store
publication, or application deployment was performed here. The repository's
normal post-merge release automation may act on that version bump.
