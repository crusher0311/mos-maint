# Isolated vehicle history fixture

Run from the workspace root:

```sh
node components/vehicle-history-fixture/server.cjs
```

Open `http://127.0.0.1:5010/`. This loopback-only Node server uses installed esbuild, React, PostCSS, and Tailwind. It builds the actual history/settings components into memory. It does not import Next, application auth, API handlers, database clients, production configuration, or secrets. There is no upstream/network fallthrough or dependency change.

API routes in this fixture return synthetic evidence and an in-memory policy. Policy starts **off**, with no selected locations. Saving the policy only changes fixture memory; restarting resets it. The fixture-role cookie selects synthetic settings responses only and is unrelated to application auth.

## Capture routes

- `/`: performed at A, declined at B, completed-elsewhere evidence, outstanding deferred work, partial coverage, and sharing settings.
- `/?view=history`: evidence only.
- `/?view=settings`: sharing settings only, initially off.
- `/?scenario=partial&view=history`: partially completed elsewhere with remaining rear-brake components.
- `/?scenario=empty&view=history`: available coverage without returned events.
- `/?scenario=off&view=history`: disabled sharing.
- `/?scenario=unavailable&view=history`: synthetic HTTP 503, unavailable rather than empty.
- `/?scenario=slow&view=history`: 4.5-second response for checking loading and switching-VIN races.
- `/?role=viewer&view=settings`: read-only policy controls.

Buttons change synthetic VINs and remount the real component. Evidence refresh, filters, visibility/focus refresh, periodic reads, authorized location selection, stage selection, and policy save use the production component logic against fixture-only responses.

History scenarios and the mutable settings example are independent synthetic responses, so settings start off even when displaying the enabled-history example.

Some tool shells terminate all child processes when a call finishes, including detached background processes. In that environment, run the foreground command in a terminal, or keep the fixture shell call alive while another tool captures port 5010:

```sh
node components/vehicle-history-fixture/server.cjs &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
sleep 60
```

Run the isolated extension/source checks without a server:

```sh
node components/vehicle-history-ui.regression.cjs
```
