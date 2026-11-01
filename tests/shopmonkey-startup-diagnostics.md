# Shopmonkey startup timing

The shorter transient retry is not evidence that the reported live 10–12 second
startup delay is fixed. This instrumentation does not make provider calls beyond
the existing authorization flow and does not alter access checks.

In the Shopmonkey tab's extension content-script console, filter for
`[MOS Shopmonkey startup]`. Records contain only stage, milliseconds, attempt
number and a fixed outcome. They are local console diagnostics, not uploaded
telemetry. Do not collect full console dumps, network exports or screenshots of
customer orders when sharing measurements.

- `context_ready`: elapsed since content script load until a usable same-tab
  order/location is observed (includes initialization and hydration wait).
- `context_to_request`: context readiness to request dispatch, including toolbar
  availability and, on later attempts, retry scheduling.
- `message_round_trip`: dispatch to callback; includes messaging overhead.
- `worker_restore`: waiting for stored login state on worker wake.
- `bootstrap_binding`: existing active-tab bootstrap checks.
- `scope_setup`, `context_validation`: scoped request setup and same-tab checks.
- `switch_location`: authorization exchange including response body decoding.
- `scope_validation`: scoped-token validation and subsequent context check.
- `request_context_validation`, `features_request`,
  `response_context_validation`: context checks surrounding the feature HTTP
  request and body decoding.
- `user_storage`: role read and final response assembly.
- `retry_wait_scheduled`: configured retry delay, not measured elapsed time.
- `controls_visible`: first mount for this scope, elapsed since script load.
  No visible record is expected when entitlements hide all controls.

Stage durations are cumulative within a request and are nested within the
message round trip; do not add the round trip to its component stages.
`incomplete` identifies the stage active when a failed response or deadline
settled. A timed-out operation may still finish internally, but cannot replace
the response or display controls. Attempt numbers are local to a controller,
not identifiers for a shop, user or browser session. Navigation creates new
scope-ready/visible records; elapsed totals remain relative to script load.

Offline verification:

```sh
node --test tests/shopmonkey-controls.browser.cjs
node tests/extension-features-deadline.cjs
node --import tsx tests/sticker-location-session.smoke.ts
```

Browser tests use Chromium with every browser request intercepted. The real
background handler and scoped-location helper execute in an isolated VM with
synthetic storage, tab and HTTP dependencies. Cold worker restore is simulated
with an unresolved storage promise; this is not a Chrome worker lifecycle test.
Early and late same-tab hydration, successful first request, scope timeout,
automatic recovery, privacy field allowlisting, gestures and stale context are
covered without live provider traffic.
