# Offline historical-sync preview

This fixture bundles the **real** `ProtractorHistoryClient` and compiles the real
`app/globals.css`. All API responses are synthetic and stored only in memory here.
It does not import the page, authenticated layout, route handlers, stores, or
providers. Production authentication is unchanged.

## Start only this fixture

From the workspace root:

```sh
env -i PATH="$PATH" HOME="$HOME" \
  PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
  NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
  node --import tsx app/platform-admin/protractor-history/tests/fixture-server.ts
```

Visit `http://127.0.0.1:5187/platform-admin/protractor-history`.
The server binds only to loopback. The visible banner identifies test-only data.
The fixture's PUT and POST handlers mutate only its local synthetic objects.
Node external traffic is denied by the repository preload; the page also has a
same-origin content security policy.

## Capture desktop and mobile

While the fixture is running, in another terminal:

```sh
env -i PATH="$PATH" HOME="$HOME" \
  PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
  NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
  node --import tsx app/platform-admin/protractor-history/tests/capture-preview.ts
```

Use `HISTORY_FIXTURE_CHROMIUM=/path/to/chromium` if Chromium is not on PATH and the
packaged Chromium cannot find system libraries. The capture script uses an
external-traffic-denying proxy, DNS restrictions, and request interception.
It checks for client errors, horizontal overflow, six rendered shops, and GET-only
requests on load. Screenshots and verification results go in `tests/screenshots`
within this directory. It does not run the main app or the existing DOM tests.

## API compatibility review

- GET supplies `{config, runtime, shops}`.
- PUT returns `{config: newConfig}`; the client does not treat it as a snapshot.
  After success it issues GET and replaces the draft with the authoritative config.
- POST returns `{ok: true, queued: boolean}`; the client issues GET afterward.
  Pause is acknowledged as a scheduled control action even though `queued` is false.
- 409 never retries a write; the operator must explicitly reload and confirm again.
- The fixture intentionally excludes the real authenticated shell. These screenshots
  verify the real client, not signed-in navigation or production integration.
