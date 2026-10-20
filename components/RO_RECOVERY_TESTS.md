# Shared repair-order UI

The dashboard continues importing `NewWorkOrderModal` with the unchanged
`onCreated(number)` callback. Workflow board and local-visit ticket creation use
that same component, not the separate intake create action. Existing local
check-in, official-ticket lookup/linking and legacy uncertain-ticket verification
remain available.

## Offline checks

```sh
node --import tsx --test components/ro-session-store.test.ts components/ro-recovery.browser.test.tsx components/NewWorkOrderModal.offline.test.tsx
npx tsc -p components/tsconfig.ro-check.json --pretty false
```

Real-browser checks against the separately running **offline-only** Vite fixture:

```sh
node tests/shop-dispatch-browser/new-ro-style.cjs
node tests/shop-dispatch-browser/new-ro.cjs
npx tsc -p tests/shop-dispatch-browser/tsconfig.json --pretty false
```

Fixture URL: `http://127.0.0.1:24100/?newRO`. The real workflow Create New RO
entry opens the real shared modal; only synthetic responses are used. Optional
flags `newROUncertain`, `newROMalformed`, `newROPhotoRetry`,
`newROHandoffRetry`, and `newRONoDvi` exercise recovery states.

The mounted tests use JSDOM, mocked fetch, synthetic in-memory photos and a small
deterministic IndexedDB API fixture. They exercise actual shared-modal concern
followups/review/cleanup, unanswered-question carry-forward, multiple concerns,
existing customer/vehicle selection, notes, mileage, canned jobs, HTTP 202,
lost-response verification, unmount/remount recovery, confirmed receipt recovery,
photo-only retries, handoff-only retries, fresh entitlement checks, no-entitlement
normal completion, and shop/actor isolation. Pure tests additionally reject
malformed success responses, invalid redirects, unsupported/oversize photos,
and creation when persistence fails.

The Playwright check uses real Chromium and IndexedDB, including actual persisted
Blob reads after reload. It verifies the complete concern flow, frozen UUID/body
recovery after HTTP 202, no automatic replay, confirmed-result reload, exact
photo/handoff retries, successful handoff navigation, read-only arrival viewing,
unchanged checklist ratings, no-entitlement completion, workflow entry, and mobile
width. Network interception rejects any request outside the fixture origin.

Screenshot-tool desktop/mobile captures and Playwright interaction-state captures
are saved under `tests/shop-dispatch-browser/screenshots/new-ro-*`.

No real provider, application database, authenticated app runtime, live credentials
or native write is used. Browser quota exhaustion, real-device camera capture and
simultaneous cross-tab transaction scheduling are not verified. The inspected
screenshots are of the offline fixture, not the signed-in production app.

## Recovery behavior

- One bounded session per shop + actor; up to 12 arrival photos of 4 MiB each,
  and at most 20 retained shop/actor sessions. Uncertain requests never expire.
- Frozen creation JSON and UUID are saved before POST. Unconfirmed, malformed,
  HTTP 202, network-error and timeout outcomes expose verification only.
- Every new mutation rechecks authenticated context; creation cannot reuse another
  shop's or advisor's session. An atomic initial IDB claim protects shared entry
  points from issuing a second initial write.
- Confirmed receipt is saved before uploads. Photo and handoff retries keep their
  own stable IDs and never invoke creation.
- No DVI entitlement leaves ordinary RO completion intact. Photo capture is
  unavailable without upload permission. If permission is revoked after capture,
  confirmed RO and blobs remain retained; the user can close/finish normally
  without discarding them.
- `?visit=...&dvi=1` opens inspection only after that exact open visit appears in
  the current authenticated workflow snapshot.
- Arrival-photo viewing is read-only and never changes findings, ratings, item
  photos, evidence revisions or checklist completeness.
- Device data clearing loses device-only recovery. An unresolved operation after
  a server crash requires operator review; the UI deliberately offers no
  “create again” escape hatch.
