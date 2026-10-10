# Cron execution leases

## Contract

`lib/cron/scheduler.cjs` admits one execution per **job name** while its lease
is valid. Both Mongo and PostgreSQL admit only absent/expired rows. A new UUID
is generated for every tick's acquisition attempt, even on the same process.
Release matches job name plus that UUID. There is deliberately **no renewal
API or heartbeat**: acquisition is not renewal, and a running execution never
reacquires after expiry. Every retry is a new invocation and a new UUID.

The existing `instanceId` (Mongo) / `instance_id` (PG) lease field stores the
UUID to avoid a schema migration. Status records retain the diagnostic boot
`instanceId` separately and also record `executionId` and `leaseRetained`.
Mongo admission uses the atomic update result rather than a later ownership
read. Duplicate-key conflicts mean admission failed. Backend errors fail closed,
with no fallback to a different store; backend selection is pinned for a run.
Existing missing-expiry Mongo rows remain eligible, as before; existing valid
legacy leases are respected until expiry or release.

## Deadlines and ambiguity

Effective TTL = max(configured TTL or 10 minutes, request timeout +
max(5 seconds, 20% of request timeout)). The default request timeout remains
5 minutes. `data-quality` and `daily-all` each get 30 minutes for their 25-minute
request deadline. Explicit longer leases are not shortened. Schedules and
pause/enable controls are unchanged.

The deadline starts before lock acquisition; acquisition latency consumes the
request budget instead of consuming safety headroom. If admission finishes too
late, no HTTP request is sent. Mongo timestamps use the initiating clock;
PostgreSQL uses database time. Keep host clocks synchronized.

A fully received HTTP response (including non-2xx) permits fenced release.
Timeouts, reset sockets, truncated responses, and other transport failures
retain the original lease until natural expiry. There is no blind extension or
cleanup delete. Operators may see skipped ticks after failure or restart for
the job's full effective TTL, not necessarily ten minutes. A retained lease is
not proof that work is still running, nor proof it has stopped.

**Residual limitation:** HTTP abort stops waiting; it cannot cancel arbitrary
route work. Server work, background effects after a response, delayed delivery,
clock skew or a stalled event loop can outlive a finite lease. After expiry a
new run may overlap that old work. Distinct job names hitting the same route
also retain separate locks. This is not exactly-once execution or effect
fencing; route-specific durable execution/idempotency is required for that.

## Operator-only rollout and rollback

No deployment, flag change, migration, or live database inspection is part of
this change. `CRON_LOCK_PG_CANONICAL` still defaults off and only exact `"1"`
selects PG. All scheduler replicas must use the same backend. Never switch
backends while work may still be running: independent stores cannot exclude
each other.

New UUID owners coexist structurally with existing rows. An old process's
instance-fenced delete cannot delete a new UUID-owned lease; its PG same-owner
refresh cannot refresh a new UUID either. However, **old replicas remain
unsafe for their own runs** (same-instance PG refresh, instance-scoped releases,
and timeout deletion). A rolling deploy does not establish fleet-wide safety.

For full protection, the operator should stop admitting ticks on all old
replicas, drain outstanding server work (not just client HTTP requests), then
replace all scheduler replicas using the unchanged backend. If work completion
cannot be established, wait conservatively and investigate rather than clearing
locks. Existing old short leases cannot be lengthened retroactively by this
code. Apply the same drain discipline on rollback; old code restores old risks.
Do not delete lease rows to accelerate either operation.

After the operator's deployment:
1. Confirm all scheduling replicas run the new version and use one unchanged
   canonical store; no schema changes are needed.
2. Observe a long-running job across repeated ticks: only the winning execution
   should dispatch; skipped ticks report `lease unavailable`.
3. Check status records for separate boot/execution identities. After a timeout,
   expect `leaseRetained: true` and skipped ticks until effective TTL expiry.
4. Confirm complete responses allow the next scheduled run; inspect long-lived
   skips against that job's TTL before diagnosing a stuck scheduler.

## Offline verification

Run `npm run test:cron-lock-pg` (also included in `test:smoke`), which invokes
`test:cron-run-leases`. The latter uses deterministic clocks, fake atomic
Mongo/PG boundaries, fake timers and transport, and actual `runJob` orchestration.
Network egress is denied; no app boot, credentials, migrations, or live stores
are required. Backend query predicates are asserted so fake behavior cannot
silently conceal reintroduction of same-owner refresh.
