# Offline Protractor settings browser checks

Run `npm run test:protractor-settings-browser`, or the full
`npm run test:protractor-onboarding` suite.

The browser bundles the real integrations page and Data Status component.
Only HTTP responses are fixtures. A synthetic, HttpOnly session cookie gates
the local server; unauthenticated API requests are checked for 401. This does
not test production session middleware.

Scenarios cover a new pending connection, retained failed import progress,
rejected credentials, and unavailable validation policy. Assertions cover the
Connect payload, absence of automatic bulk requests, status after reload,
explicit restricted Sync Now requests, unchanged saved state, and absence of
misleading import-success messages.

The runner clears inherited credentials, denies Node network egress except
loopback, and confines Chromium with a deny proxy, DNS restrictions, and
request interception. Unknown fixture endpoints and browser errors fail the
test. No Next server, provider client, store, or real session code is loaded.
Existing onboarding route/transport tests remain responsible for real server
error classification; browser responses are deterministic contract examples.
