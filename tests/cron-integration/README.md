# Real-server cron lease checks (opt-in)

Run **Isolated cron lease integration** from GitHub Actions → Run workflow.
The workflow creates disposable MongoDB 7 and PostgreSQL 16 services, runs the
actual scheduler lock helpers through eight independent connections, then
discards the services. No repository/environment secrets are referenced.
This workflow is manual only. The existing offline command and prebuild chain
are unchanged.

Coverage: repeated simultaneous new-key admission (one winner), real uniqueness
errors (Mongo 11000 / PostgreSQL 23505), live-owner reentry denial, natural
expiry followed by concurrent takeover, stale execution release, owner release,
and reacquisition. Mongo command monitoring also confirms actual scheduler
upserts encounter duplicate-key responses and convert them to non-admission.
The same opt-in command also runs six real-driver network-fault cases (three
per backend) through a test-owned TCP proxy:

* Acquisition commits, but server response bytes are withheld and the connection
  is cut. An independent connection proves the lease exists, the driver reports
  failure, and repeated contenders are denied before natural expiry.
* Release request bytes are withheld before reaching the server, then the
  connection is cut. The retained lease excludes contenders until natural expiry.
* Release commits, but acknowledgment bytes are withheld before the connection
  is cut. The observed deletion permits a successor without waiting for expiry.

After healing the proxy, each case races independent connections for exactly
one successor, retries the old execution's release to prove it cannot delete
the successor, then verifies legitimate release and recovered-client admission.
The proxy binds an ephemeral loopback port and only forwards to the two fixed
disposable service ports. Faults are armed after handshakes; byte counters and
independent database observations establish fault placement without sleeps that
guess commit timing, driver mocks, server failpoints, or application clients.
For PostgreSQL the proxy forwards Parse/Describe replies (the driver needs them
before sending Execute), then suppresses DataRow/CommandComplete/ReadyForQuery
frames, handling fragmented and coalesced TCP chunks.
Mongo helpers swallow network errors (returning false for acquisition); the PG
storage helper rejects and the existing offline suite covers scheduler-level
fail-closed handling. This tests standalone-server TCP interruption, not replica
failover, rollback durability, or orchestration. The default offline suite and
prebuild chain remain unchanged.

## Local disposable services

Use **only newly created local test services**, never a port-forward, tunnel,
shared developer service, or production store. No Docker is needed in Replit:
installed `mongod` and PostgreSQL binaries can serve temporary data directories
for a single test command. Elsewhere, the CI service definitions document the
equivalent disposable container configuration.

Required endpoints (intentionally not customizable):

* MongoDB: `127.0.0.1:27185`, no authentication, bound to loopback.
* PostgreSQL: `127.0.0.1:55485`, database/user `cron_lease_test`, disposable
  password `disposable_only`. This user must be able to create a schema.

After starting isolated services, run:

```sh
env -i PATH="$PATH" HOME="$HOME" \
  CRON_LEASE_INTEGRATION=disposable-only \
  CRON_LEASE_TEST_MONGO_URL=mongodb://127.0.0.1:27185/cron_lease_test \
  CRON_LEASE_TEST_PG_URL=postgres://cron_lease_test:disposable_only@127.0.0.1:55485/cron_lease_test \
  npm run test:cron-run-leases:integration
```

Missing opt-in or configuration **fails**, rather than silently skipping.
The guard rejects application database variable names before reading values,
as well as remote hosts, alternative credentials, database names, and URL
options. It never loads `.env` or falls back to scheduler application clients.
Run just the safety checks without databases using
`node --test tests/cron-integration/config.test.cjs`.

Each run creates a UUID-named Mongo database and PostgreSQL schema, cleaning
only those namespaces in `finally` and closing all connections. It does not
apply application migrations or clear existing lock collections/tables.
Destroy local services and their temporary directories after the command,
including on failure; forced termination may leave the run namespace behind.
Driver timeouts, test deadlines, and the CI job deadline bound failures.
