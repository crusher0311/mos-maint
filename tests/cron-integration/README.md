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
These are storage-level contract checks, not a claim about failover or network
partitions. Existing offline tests continue to cover orchestration.

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
