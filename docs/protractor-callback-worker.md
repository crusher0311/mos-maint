# Dedicated callback worker

Disabled by default. This does not enable history imports or remove any shared
operator stop, relay pacing, callback ownership, retry, or admission restrictions.

Start command: `node --import tsx scripts/protractor-callback-worker.ts`

The worker runs the existing durable callback drain directly, never via an HTTP
request to the website. Batches remain serial and bounded to the existing
40-second admission budget. A successful batch is followed by a one-second
pause; empty/policy-denied batches wait ten seconds. Exceptions back off up to
sixty seconds. SIGTERM/SIGINT stops new admissions while admitted work settles.
Do not assume a process termination grace period cancels database writes.

## Operator deployment

1. Deploy the code with the default `PROTRACTOR_CALLBACK_EXECUTION_TARGET=web`.
   Existing web drains remain unchanged.
2. Provision a **separate callback-only Render worker**, not either historical
   backfill worker. It must inherit the approved production database/relay
   configuration and stable Render instance identity. Check the instance deny
   policy and existing shared live admission state; this code grants no access.
3. On that worker only, set `PROTRACTOR_CALLBACK_EXECUTION_TARGET=worker` and
   `PROTRACTOR_CALLBACK_WORKER_ENABLED=true`, with `PROTRACTOR_RELAY_MODE=relay`.
   Development preview execution is rejected.
4. Verify worker batches and callback progress before setting
   `PROTRACTOR_CALLBACK_EXECUTION_TARGET=worker` on the web service. That switch
   disables both web callback-drain entry paths at the shared drain boundary.
   Brief overlap during handoff retains existing per-object fences and global
   pacing; it does not guarantee zero redundant selection.
5. Observe actual callback age, processed outcomes, transport errors, interactive
   latency and database load. Do not increase provider concurrency.

Rollback: restore the web execution target to `web`, verify scheduled drains,
then stop the dedicated worker. Do not clear callback claims or recovery state.

This first implementation removes minute-scheduler idle gaps and isolates
processing from the web process. It intentionally does **not** pipeline database
writes or change their timeouts. Those changes require a separate durable
handoff design to preserve terminal ordering and completion evidence.

Offline verification:
`node --import tsx tests/protractor-callback-worker.smoke.ts`
plus the existing callback queue runtime and selection suites.
