# Legacy Protractor DVI push outcomes

This is a status-reporting change, not a visit-DVI release or authorization for live provider writes. The visit release gate is unchanged.

Both push routes keep `ok`, `workOrderId`, counts and `inspectionResultsWritten`. In particular `ok: true` still means the package stage was acknowledged, not that every stage completed.

Additive fields:

- `packageStatus`: `acknowledged` or `uncertain`.
- `resultsStatus`: `acknowledged`, `not_requested`, or `uncertain`.
- `readBackStatus`: `not_performed`. A write acknowledgment does not prove provider display correctness.
- `localReceiptStatus`: `recorded` or `unconfirmed`.
- `outcome`: `complete`, `partial` (package acknowledged, findings unconfirmed), or `uncertain` (package or local receipt unconfirmed).
- `message`: fixed, staff-safe verification guidance for incomplete outcomes.
- `recoveryAllowed`: always false.

The native helper does not expose reliable evidence distinguishing a rejected write from an admitted write whose acknowledgment was lost. Both are conservatively unconfirmed; do not claim that nothing was saved. Exceptions and package-stage failures likewise never authorize replay. Raw native errors are not returned by either route.

Staff should check the exact work order's package and inspection view, then contact support if reconciliation is needed. The dashboard and extension block repeat clicks in the current panel after an incomplete result or response loss. The extension keeps its lock and visible warning in work-order-scoped panel state across photo, voice, and generation rerenders, including navigation away and back. This is not a durable server idempotency lock; reopening the panel is **not** permission to retry.

No recovery endpoint or retry button is introduced. Safe future recovery requires durable stable operation/payload identity, persisted exact package/line IDs before admission, exact-ID reconciliation after ambiguous outcomes, and detection of provider edits before a stage-only write. Title matching in the legacy writer does not satisfy that contract, particularly for priced recommended packages.

## Offline verification

```
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node_modules/.bin/tsx --test tests/auto-dvi-push-outcomes.test.ts
node --check mos-tools-extension/sidepanel.js
```

Tests execute the transport, both real route handlers, and the actual UI handler bodies using isolated provider/repository mocks. They cover full acknowledgment, findings failure, admitted timeout, package timeout, local receipt loss and browser response loss, including no automatic replay and no raw provider error exposure. The real extension renderer is also executed with DOM replacement: a new button remains disabled, the warning remains visible, and switching work orders cannot clear the affected order's lock.

`node_modules/.bin/tsx tests/browser/dvi-push-fixture-server.ts` serves the real dashboard notice component with offline scenarios on port 5000. It does not start Next, connect to stores, or invoke provider APIs. This verifies the notice, not the signed-in full dashboard.
