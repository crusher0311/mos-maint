# MOS Print Windows installer

## Status

An unsigned **pilot** installer and native PowerShell/Windows Forms setup wizard
are implemented. This is not a production-qualified installer. Linux checks do
not prove Windows elevation, ACLs, Task Scheduler, reboot behavior, or physical
print output. No shop was contacted during development.

The server release must include `/api/print-agent/setup` and the saved IPP
printing routes before the wizard can verify a shop. That identity endpoint
requires a dedicated shop `print:agent` key and returns only shop ID/name; it
does not claim or enqueue print jobs. Standard API-key usage accounting remains.

## Build

With the agent's locked dependencies installed and NSIS (`makensis`) available:

```
npm --prefix zink-print-agent run package:win:installer
```

Output: `generated-artifacts/mos-print-installer/MOS-Print-Setup-pilot.exe`.
The executable bundles the Windows x64 Node runtime; Bryce does not install
Node, manually extract a ZIP, edit JSON, or type enrollment commands.

## Bryce's pilot flow

1. Run the approved installer on Windows x64 and approve administrator access.
2. Open the setup wizard from the finish page or **MOS Print → Shop Setup**
   in the Start menu (administrator approval required).
3. Start from **MOS → Settings → Printing → Set up this computer** and download
   the installer directly (no ZIP). In the wizard click **Connect this computer**.
   It opens MOS in the default browser; sign in as a manager if necessary,
   verify the selected shop, and click **Confirm connection**. Return to the
   wizard and click **Check connection**, then explicitly confirm the returned
   shop name and ID. If signing in lost the link, click **Connect this computer**
   again; the same unexpired request is reused. No API key is copied or shown.
   Existing IPP installations reuse their saved key, never silently reassign shops.
4. Click **Find printers**, select a discovered address (or enter a known IPP
   address), name the printer, and enter exact loaded stock dimensions in mm.
   Click **Enroll selected printer**. No calibration print is sent by enrollment.
5. Click **Enable automatic startup**. This registers and starts the Windows task.
   Starting the agent permits it to claim queued work for this installation;
   it is not a read-only connection test.
6. Click **Open Printing settings**. Sign in to MOS normally as a shop manager,
   select the enrolled destination, save the intended default, and explicitly
   send a calibration label there. The wizard does not borrow browser credentials
   or automatically send/retry a label. Physical calibration is not attested by
   the wizard; measure and record it in the hardware pilot.
7. Verify dimensions, margins, QR, orientation and cut, then reboot and repeat.
   Repeat enrollment for a second printer only after the first passes.

The Windows agent computer must stay on and connected. Unknown outcomes require
inspection, not repeated clicks or automatic browser fallback. Keytag hardware
is still unsupported.

## In-app distribution and connection

The updated web routes and updated installer must both ship. The old standalone
installer is not compatible with this browser-pairing flow. Until the release
artifact is distributed, the app explicitly displays that no download is available.

Only Service Solutions Garage (shop 63), the user-approved pilot, can download
or approve computer setup. Other locations are rejected server-side, including
platform administrators viewing them. Impersonated sessions cannot approve.
No new production deployment, artifact upload, or enrollment was performed
while implementing this flow.

Packaging creates `pairing-release.json` beside the executable. After separate
release approval, run `node scripts/publish-print-installer.cjs` for local
checksum validation; `--execute` uploads the immutable executable to the
existing external Mongo GridFS store and installs the pairing-expiry TTL index.
Do not run `--execute` as a test. It changes production storage. It does not
deploy the web code or activate/start any printer. It refuses to overwrite
different contents for the same release. No executable belongs in Git.

The web download requires manager access, is checksum-verified and capped at
32 MiB. Device requests have rate and size limits. A ten-minute random pairing
capability travels in a browser fragment, not a server URL/query string.
The UI removes the fragment and requires explicit same-origin, current-shop
approval. Only one concurrent approval may mint a dedicated `print:agent` key.
The credential is encrypted to the device's RSA key; Mongo stores neither its
plaintext nor the raw pairing capability. Repeated status checks return the
same ciphertext until expiry, allowing lost-response recovery without minting
another key. The private key stays in the protected installation directory.
The wizard validates the credential's shop before atomically retaining config.

If approval stops after its claim, it is not automatically replayed. A known
new credential is revoked on failure; an indeterminate key-creation outcome
requires reviewing/revoking the unused “MOS Print computer setup” key in normal
API-key settings. Reboot, real Windows ACLs and hardware still require pilot
qualification. Do not bypass SmartScreen or enterprise policy.

## Updates, cancellation, and removal

- The installer pauses/disables the scheduled task before replacing executables.
  A foreground agent blocks replacement. Existing TCP installations are rejected
  without conversion; their separate reviewed migration remains out of scope.
- Cancellation or failure leaves printing paused. Resume from the setup shortcut.
  Do not delete the journal or enrollment locks to force a retry.
- Upgrades retain config, installation ID, printer enrollment, journals and
  locks. The wizard stops background printing before changing enrollment.
- Uninstall removes the task, program and shortcut but intentionally retains
  configuration (including the dedicated key), enrollments, logs and journals.
  For retirement, revoke the dedicated key in MOS. Securely removing retained
  data is a separate operation after confirming no pending/uncertain jobs.
- The native wizard uses stdin for credentials, not command-line parameters;
  it opens no HTTP listener. Installer paths are fixed, reparse points rejected,
  and files restricted to SYSTEM/Administrators.

## Release gates still outstanding

1. Windows x64 clean install, upgrade, cancellation, uninstall and reinstall.
2. ACL/elevation checks with an ordinary non-admin account, simultaneous setup,
   interrupted install, file locks, and Task Scheduler behavior after reboot.
3. One-printer then two-printer physical qualification, including lost responses
   and power interruption. No automatic duplicate output is permitted.
4. Review and Authenticode-sign the executable/scripts/installer using an
   approved signing process. Do not instruct shops to bypass SmartScreen or
   enterprise policy. The pilot runs local scripts with process-scoped execution
   policy; enterprise-enforced restrictions must be respected.
5. Separately approve the web/extension release and controlled pilot activation.

Offline checks passed: agent suite (68 tests), setup route authentication/scope,
TypeScript, auth/data-access gates, native script syntax parsing and NSIS compile.
No Windows GUI or signed-in live customer flow was verified in this Linux workspace.
