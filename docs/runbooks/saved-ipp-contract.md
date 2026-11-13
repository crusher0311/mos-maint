# Saved IPP printing — compatibility findings and integration contract

## Current implementation boundary

The software pilot includes authenticated cloud routing and production web/
extension controls. **Hardware approval remains pending.** The explicit `ipp`
configuration enables a versioned lane in the existing queue and executable.
Without that setting legacy TCP operation is unchanged. Legacy agents and
retry/delete controls cannot claim or mutate IPP jobs.

Implemented locally:

- Bounded IPP codec and IPP/IPPS transport, with normal TLS verification, no
  redirects, no automatic POST retries and no cloud credentials on LAN requests.
- Three-second mDNS browse (at most 32 candidates), explicit capability-checked
  enrollment, friendly names, exact loaded stock and UUID-derived identities.
- Static IPP URI enrollment when DNS-SD is unavailable.
- PNG preservation, CRC/envelope checks, explicit physical media dimensions,
  borderless media matching, no guessed rotation, and no media fallback.
- Printer acceptance versus completion evidence, and conservative unknown
  outcomes on lost/malformed/substituted responses.
- Durable logical-submission markers and cross-process printer locks. An
  interrupted sending record is never treated as permission to print again.
- Isolated tests; no live database, agent, or printer was contacted.

Integrated software surfaces:

- Authenticated cloud inventory, capabilities, shop/printer ownership and
  heartbeat handling.
- Versioned PNG jobs, fenced claims and acknowledgments, deduplicated enqueue,
  acknowledgment reconciliation, status reads, and guarded manual retries.
- Authorized shop defaults, separate sticker/keytag stock, scoped browser
  overrides and one-print selection.
- Production web **and** Detect Dog extension print-control integration,
  preserving existing rendering, entitlements, RO context and browser printing.
- Integrated Windows update/reboot handling and diagnostics, a runnable full
  pilot bundle, and cloud/browser/lost-response regression coverage.

## Reference source inspection

The ZIP was listed, and selected Python sources were read using `unzip -p`.
No installer, bundled virtual environment, service, or script was executed.

Useful reference behavior:

- `mosdog_server/ipp.py`: IPP/2.0 operation/group/value tags, nested collection
  encoding, Print-Job and Get-Printer-Attributes.
- `mosdog_server/discovery.py`: `_ipp._tcp` and `_ipps._tcp` DNS-SD services,
  SRV/TXT resource paths, and discovery distinct from actual IPP capabilities.
- `mosdog_server/server.py`: source PNG preservation and dimensions expressed in
  hundredths of millimetres; some printers need `media-col-database` queried
  separately from other attributes.

Not adopted:

- Unauthenticated browser-to-LAN print endpoints or forwarding reusable MOS
  tokens to LAN HTTP.
- Automatic printer selection or switching destinations when discovery changes.
- Disabled TLS certificate verification.
- Success-with-substitution treated as an exact-size successful print.
- Claiming initial Print-Job acceptance proves physical completion.

Reference use of `print-scaling=fit` differs from this conservative protocol
implementation's `none`. **Media-col and a successful reply are not physical
sizing evidence.** PNG intrinsic resolution, printer scaling behavior, cut
behavior and firmware must be measured before approving a hardware profile.
The current profile may reject hardware that the reference prints on; do not
weaken checks or claim compatibility without reviewing that evidence.

## Compatibility and missing evidence

| Path | Format | State |
|---|---|---|
| Existing TCP 9100 agent | JPEG + ZINK XML | Retained unchanged |
| New IPP cloud lane | Exact rendered PNG | Explicitly configured software pilot |
| ZINK hAppy model family | Advertised PNG, UUID, exact borderless media, no-scaling required | Software candidate only; hardware unvalidated |
| Brother VC-500W IPP | Unverified | Unsupported; existing TCP path retained |
| Keytag IPP hardware | Unverified | Unsupported until a profile is explicitly validated |
| Arbitrary USB/Dymo/Zebra | Unverified | Out of scope |

Missing pilot inputs: exact model and firmware for each printer, advertised IPP
attributes and UUID, stock product and measured width/length, feed orientation,
cut mode and cut result, connectivity and TLS certificate trust, Windows
version/architecture and account, Android/Chromebook/browser/extension versions,
and measured output after restart and reboot. Reported shop success is not
independent hardware evidence.

## Cloud contract

Keep legacy jobs and legacy polling compatible. A new job must carry an
explicit protocol discriminator, PNG MIME type, logical action ID, authorized
agent installation ID, stable enrolled printer ID, kind, integer physical
dimensions, stock/config revision, and per-claim fence. Never send a LAN URI
or host/port in a job.

The authenticated agent publishes inventory for its **server-authorized shop**
and installation. Capability must be explicit, not inferred from version text.
Only locally enrolled inventory is routable. Removed and offline destinations
must never resolve to another enrolled printer. The agent must recheck UUID,
model and current media before physical submission. Shop reassignment must
invalidate old inventory, claims and preferences.

The server must derive shop scope from auth for inventory, defaults, enqueue,
claims, acknowledgments and status; a request-supplied shop ID is not authority.
Browser/cloud submissions stay HTTPS. The agent's dedicated cloud credential
is not a browser session token and never appears in printer traffic.

Resolution order:

1. Explicit one-print override, without saving it.
2. Explicit browser/device override keyed by shop and label kind.
3. Explicit shop default keyed by label kind.
4. Missing-default state offering setup or an intentional browser print.

An unavailable higher-priority selection is an error, **not** permission to
continue down this list. Saving a default is a separate user action. A stale
selected stock revision must be corrected explicitly before enqueue.

Queue acceptance is not printer acceptance. New jobs must distinguish
`queued`, `claimed`, `printer-accepted`, `completed`, `failed`, and `unknown`.
Completion requires printer evidence. Stale claims must not automatically make
potentially printed jobs claimable again. After an acknowledgment is lost,
reconcile the same persisted evidence with the same fence without physical
resubmission. Unknown jobs must never trigger automatic browser fallback.
Guard manual retry/reset/delete paths too; deleting a record must not erase
deduplication authority while its logical action can still be retried.

## Local setup and explicit activation (separate approval required)

After pilot authorization, copy `config.ipp.example.json` to
`C:\ZinkPrintAgent\config.json`. Set a dedicated `print:agent` key and a unique
installation UUID. Preserve that UUID, enrollment file and journal directory
across updates. Never clone them to a second running installation.
The `ipp` config selects IPP instead of legacy TCP claiming; the legacy `printer`
field remains for configuration compatibility and is unused in IPP mode.
Enroll locally, run in the foreground, then register the scheduled task.
Select defaults in `/dashboard/settings/printing` or the extension controls.

For updates, stop the scheduled task and foreground processes. Replace only
executable files, never `config.json`, `printers.json`, or `ipp-journal`.
Rerun registration to secure existing files before starting. Never erase an
interrupted journal/lock to retry a potentially printed job. Inspect output and
queue status first. Managers can explicitly send a calibration label from
printing preferences.

Build with `cd zink-print-agent && npm run build`. The existing executable
entrypoint now supports:

```text
node dist/index.js --ipp-discover
node dist/index.js --ipp-list --ipp-file C:\ZinkPrintAgent\printers.json
node dist/index.js --ipp-enroll --uri ipp://printer.local:631/ipp/print \
  --name "Front counter" --kind sticker --width-mm 50.8 --height-mm 50.8 \
  --ipp-file C:\ZinkPrintAgent\printers.json
node dist/index.js --ipp-remove <printer-id> --ipp-file C:\ZinkPrintAgent\printers.json
```

The example dimensions are illustrative, not a hardware recommendation.
Use the verified loaded stock. Static addresses use the same enrollment command.
An unsupported printer or keytag model is rejected. IPPS uses platform trust;
there is no insecure TLS bypass. Enrollment only inspects capabilities and saves
local configuration; it does **not** submit a test print.

These commands contact local printers and require separate pilot authorization.
They were **not run against a shop** during development.

Stop all agent instances before editing enrollments. Keep enrollment and journal
directories accessible only to administrators/service identity. Windows
installer ACL handling protects these files. Journal scope
must bind the cloud shop and installation. Preserve journals across upgrades;
do not copy them to a differently scoped installation or delete sending records.
The worker serializes all routes within a process and uses a per-printer lock
across processes sharing that journal. A crashed process leaves a lock requiring
operator investigation, not automatic stale-lock deletion. This intentionally
prefers blocking over accidental physical output. Windows power-loss durability
is not established by Node file flush tests.

## Isolated verification

From workspace root, with no secrets passed to the test process:

```sh
env -i PATH="$PATH" HOME="$HOME" PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
  NODE_OPTIONS="--require $PWD/tests/helpers/deny-network-egress.cjs" \
  sh -c 'cd zink-print-agent && npm run build && npm test'
```

The fake-printer tests cover collection encoding, request IDs, truncated and
oversized replies, CRC and geometry rejection, exact media checks, discovery,
explicit enrollment/removal, multiple routes, serialization, restart/duplicate
protection, unavailable journals, changed identity, response loss, and
acceptance-versus-completion. The isolated real-Mongo integration suite adds
shop scoping, concurrent deduplication, claim fences, removal/offline rejection
and legacy exclusion. Frontend tests and the offline browser fixture cover
preferences and controls. None establishes physical output correctness,
Windows reboot behavior or power-loss durability.

## Physical acceptance checklist — pending, separate approval required

1. Capture exact model/firmware/client/stock details without label content,
   reusable tokens or credentials.
2. Start with one supported ZINK candidate; measure width/height and margins,
   scan the existing QR target, inspect branding, color, orientation and cuts.
3. Test disconnect-before-send, disconnect-after-send and dropped response:
   unknown must not cause a second physical print or browser fallback.
4. Restart then reboot: preserve enrollment and send evidence; verify startup
   permissions and physical sizing/cut behavior again.
5. Add a second ZINK; verify explicit routing, friendly names, removal,
   stock changes, offline selections and no fallback between devices.
6. Verify Android web and Chromebook web/extension cloud-only submission,
   per-location/device defaults, one-print selection and duplicate clicks.
7. Add keytag hardware only after its PNG/media/cut capabilities and physical
   profile are independently confirmed. Until then label it unsupported.

No production deployment, Web Store publish, database change, live installation,
shop enrollment or activation is authorized by this document.
