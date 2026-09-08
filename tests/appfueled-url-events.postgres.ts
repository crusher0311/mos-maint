import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import {
  __deps,
  authenticateAppFueledHook,
  captureDelivery,
  changeConnection,
  cleanupExpiredAppFueledReceipts,
  ConnectionIdConflictError,
  createConnection,
  listConnections,
  listReceipts,
  listVehicleUrls,
  type AppFueledConnection,
} from "../lib/data/repositories/appfueled-url-events";

const VIN = "1M8GDM9AXKP042788";
const ACTOR = "postgres-fixture-admin";
const IP_HASH = "f".repeat(64);

function run(binary: string, args: string[], childEnv: Record<string, string>) {
  const result = spawnSync(binary, args, {
    env: { ...childEnv, NODE_ENV: "test" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${binary} failed with status ${result.status}: ${result.stderr.trim()}`);
  }
}

async function waitForLock(sql: ReturnType<typeof postgres>, connectionId: string) {
  let locked!: () => void;
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => { locked = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const transaction = sql.begin(async (tx) => {
    await tx.unsafe("SELECT id FROM appfueled_url_connections WHERE id=$1 FOR UPDATE", [connectionId]);
    locked();
    await released;
  });
  await acquired;
  return { release, transaction };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "task1257-pg16-"));
  const data = join(root, "data");
  const socket = join(root, "socket");
  const log = join(root, "postgres.log");
  const port = randomInt(20_000, 60_000);
  const pgBin = process.argv[2] || "/nix/store/bgwr5i8jf8jpg75rr53rz3fqv5k8yrwp-postgresql-16.10/bin";
  const childEnv = {
    PATH: `${pgBin}:/usr/bin:/bin`,
    HOME: root,
    LANG: "C",
    LC_ALL: "C",
  };
  let started = false;
  let sql: ReturnType<typeof postgres> | undefined;
  const originalGetSql = __deps.getSql;

  try {
    await mkdir(socket, { mode: 0o700 });
    run(join(pgBin, "initdb"), [
      "-D", data,
      "--username=runner",
      "--auth-local=trust",
      "--auth-host=reject",
      "--encoding=UTF8",
      "--no-locale",
      "--no-instructions",
    ], childEnv);
    run(join(pgBin, "pg_ctl"), [
      "-D", data,
      "-l", log,
      "-w",
      "start",
      "-o", `-F -p ${port} -k '${socket}' -c listen_addresses=''`,
    ], childEnv);
    started = true;
    run(join(pgBin, "createdb"), [
      "-h", socket,
      "-p", String(port),
      "-U", "runner",
      "task1257_fixture",
    ], childEnv);

    sql = postgres({
      host: socket,
      port,
      database: "task1257_fixture",
      username: "runner",
      max: 8,
      prepare: false,
      connect_timeout: 2,
    });
    __deps.getSql = () => sql!;

    const migration = await readFile(
      join(process.cwd(), "drizzle/0036_task1257_appfueled_url_events.sql"),
      "utf8",
    );
    await sql.unsafe(migration);
    await sql.unsafe(migration);

    const expectedIndexes = [
      "appfueled_url_connections_connection_id_uq",
      "appfueled_url_connections_token_hash_uq",
      "appfueled_url_connections_shop_idx",
      "appfueled_url_receipts_connection_correlation_uq",
      "appfueled_url_receipts_received_idx",
      "appfueled_url_receipts_shop_received_idx",
      "appfueled_url_receipts_connection_received_idx",
      "appfueled_url_receipts_vin_received_idx",
      "appfueled_url_receipts_outcome_received_idx",
      "appfueled_vehicle_urls_shop_vin_idx",
      "appfueled_vehicle_urls_received_idx",
      "appfueled_url_rate_buckets_expires_idx",
    ];
    const actualIndexes = await sql.unsafe(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[])",
      [expectedIndexes],
    );
    assert.deepEqual(
      new Set(actualIndexes.map((row) => row.indexname)),
      new Set(expectedIndexes),
      "all repository query indexes are reproducibly present after the rerun",
    );
    const expectedChecks = [
      "appfueled_url_connections_id_lengths_check",
      "appfueled_url_connections_provisioning_check",
      "appfueled_url_connections_mos_namespace_check",
      "appfueled_url_receipts_bounds_check",
      "appfueled_vehicle_urls_bounds_check",
    ];
    const actualChecks = await sql.unsafe(
      `SELECT conname FROM pg_constraint
       WHERE contype='c' AND connamespace='public'::regnamespace AND conname = ANY($1::text[])`,
      [expectedChecks],
    );
    assert.deepEqual(
      new Set(actualChecks.map((row) => row.conname)),
      new Set(expectedChecks),
      "all migration check constraints are reproducibly present",
    );
    const rlsTables = await sql.unsafe(
      `SELECT relname,relrowsecurity FROM pg_class
       WHERE relnamespace='public'::regnamespace
         AND relname = ANY($1::text[])`,
      [[
        "appfueled_url_connections",
        "appfueled_url_receipts",
        "appfueled_vehicle_urls",
        "appfueled_url_rate_buckets",
      ]],
    );
    assert.equal(rlsTables.length, 4);
    assert.ok(rlsTables.every((row) => row.relrowsecurity),
      "all four sensitive tables have row-level security enabled");

    const tokenA = "a".repeat(64);
    let connection = await createConnection({
      connectionId: "provider-shop-42",
      mosShopId: 42,
      incomingShopId: 42,
      shopIdNamespace: "mos",
      namespaceConfirmation: "verified fixture mapping",
      allowedHosts: ["inventory.example.test"],
    }, ACTOR, tokenA);

    await assert.rejects(
      createConnection({
        connectionId: "provider-shop-42",
        mosShopId: 99,
        incomingShopId: 99,
        shopIdNamespace: "mos",
        namespaceConfirmation: "conflicting fixture mapping",
        allowedHosts: ["other.example.test"],
      }, ACTOR, "b".repeat(64)),
      ConnectionIdConflictError,
    );
    const preserved = await listConnections();
    assert.equal(preserved.length, 1);
    assert.equal(preserved[0].mosShopId, 42, "connection-id conflict must preserve its original shop");

    assert.equal((await authenticateAppFueledHook(tokenA))?.id, connection.id);
    assert.equal(await authenticateAppFueledHook("9".repeat(64)), null);

    const delivery = (
      c: AppFueledConnection,
      tokenHash: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      connection: c,
      tokenHash,
      correlationId: randomUUID(),
      receivedAt: new Date(),
      vin: VIN,
      payload: { fixture: true },
      outcome: "accepted" as const,
      reason: "accepted",
      vehicleUrl: `https://inventory.example.test/${randomUUID()}`,
      startedAt: Date.now() - 125,
      ipHash: IP_HASH,
      deadlineAt: Date.now() + 3_500,
      ...overrides,
    });

    const duplicateInput = delivery(connection, tokenA);
    const duplicateResults = await Promise.all([
      captureDelivery(duplicateInput),
      captureDelivery(duplicateInput),
    ]);
    assert.equal(new Set(duplicateResults.map((row) => row.receiptId)).size, 1);
    const duplicateRows = await sql.unsafe(
      "SELECT count(*)::int AS count FROM appfueled_url_receipts WHERE correlation_id=$1",
      [duplicateInput.correlationId],
    );
    assert.equal(duplicateRows[0].count, 1, "concurrent duplicate deliveries create one receipt");

    const sameTime = new Date(Date.now() + 1_000);
    const concurrentA = delivery(connection, tokenA, {
      receivedAt: sameTime,
      vehicleUrl: "https://inventory.example.test/concurrent-a",
    });
    const concurrentB = delivery(connection, tokenA, {
      receivedAt: sameTime,
      vehicleUrl: "https://inventory.example.test/concurrent-b",
    });
    await Promise.all([captureDelivery(concurrentA), captureDelivery(concurrentB)]);
    const concurrentCounts = await sql.unsafe(
      `SELECT
         (SELECT count(*)::int FROM appfueled_url_receipts WHERE correlation_id IN ($1,$2)) AS receipts,
         (SELECT count(*)::int FROM appfueled_vehicle_urls WHERE connection_id=$3 AND mos_shop_id=42 AND vin=$4) AS associations`,
      [concurrentA.correlationId, concurrentB.correlationId, connection.id, VIN],
    );
    assert.deepEqual(
      [concurrentCounts[0].receipts, concurrentCounts[0].associations],
      [2, 1],
      "different concurrent deliveries retain both receipts and one association",
    );

    const newest = delivery(connection, tokenA, {
      receivedAt: new Date(Date.now() + 20_000),
      vehicleUrl: "https://inventory.example.test/newest",
    });
    const older = delivery(connection, tokenA, {
      receivedAt: new Date(Date.now() + 10_000),
      vehicleUrl: "https://inventory.example.test/older",
    });
    await captureDelivery(newest);
    await captureDelivery(older);
    const newestAssociation = await listVehicleUrls({ connectionId: connection.id });
    assert.equal(newestAssociation.vehicleUrls.length, 1);
    assert.equal(newestAssociation.vehicleUrls[0].vehicleUrl, newest.vehicleUrl);
    assert.equal(newestAssociation.vehicleUrls[0].connectionId, "provider-shop-42");

    const receiptFilter = await listReceipts({ connectionId: connection.id });
    assert.ok(receiptFilter.receipts.length >= 5, "internal UUID receipt filter returns fixture rows");
    assert.ok(receiptFilter.receipts.every((row) => row.connectionId === "provider-shop-42"));
    assert.equal((await listReceipts({ connectionId: randomUUID() })).receipts.length, 0);

    const tokenC = "c".repeat(64);
    const rotateLock = await waitForLock(sql, connection.id);
    const rotation = changeConnection(connection.id, "rotate", ACTOR, tokenC);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const staleAfterRotate = captureDelivery(delivery(connection, tokenA));
    rotateLock.release();
    await rotateLock.transaction;
    connection = (await rotation)!;
    const rotatedResult = await staleAfterRotate;
    assert.deepEqual([rotatedResult.outcome, rotatedResult.reason, rotatedResult.status],
      ["rejected", "token_rotated", 401]);
    assert.equal(await authenticateAppFueledHook(tokenA), null);
    assert.equal((await authenticateAppFueledHook(tokenC))?.id, connection.id);

    const disableLock = await waitForLock(sql, connection.id);
    const disabling = changeConnection(connection.id, "disable", ACTOR);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const staleAfterDisable = captureDelivery(delivery(connection, tokenC));
    disableLock.release();
    await disableLock.transaction;
    await disabling;
    const disabledResult = await staleAfterDisable;
    assert.deepEqual([disabledResult.outcome, disabledResult.reason, disabledResult.status],
      ["rejected", "connection_disabled", 403]);

    const tokenD = "d".repeat(64);
    connection = (await changeConnection(connection.id, "rotate", ACTOR, tokenD))!;

    await sql.unsafe(
      "ALTER TABLE appfueled_vehicle_urls ADD CONSTRAINT appfueled_fixture_association_failure CHECK (vehicle_url <> 'https://inventory.example.test/association-failure')",
    );
    const failedCorrelation = randomUUID();
    await assert.rejects(
      captureDelivery(delivery(connection, tokenD, {
        correlationId: failedCorrelation,
        vehicleUrl: "https://inventory.example.test/association-failure",
      })),
      (error: any) => error?.code === "23514" &&
        error?.constraint_name === "appfueled_fixture_association_failure",
    );
    const rolledBack = await sql.unsafe(
      "SELECT count(*)::int AS count FROM appfueled_url_receipts WHERE correlation_id=$1",
      [failedCorrelation],
    );
    assert.equal(rolledBack[0].count, 0, "association constraint failure rolls back its receipt");
    await sql.unsafe(
      "ALTER TABLE appfueled_vehicle_urls DROP CONSTRAINT appfueled_fixture_association_failure",
    );

    const persisted = await sql.unsafe(
      `SELECT r.duration_ms,c.last_success_at,c.last_receipt_id
       FROM appfueled_url_receipts r
       JOIN appfueled_url_connections c ON c.id=r.connection_id
       WHERE r.id=$1`,
      [newestAssociation.vehicleUrls[0].sourceReceiptId],
    );
    assert.ok(persisted[0].duration_ms >= 100, "server-finalized duration is persisted");
    assert.ok(persisted[0].last_success_at instanceof Date);
    assert.ok(persisted[0].last_receipt_id, "last-success provenance is persisted");

    const sourceReceiptId = newestAssociation.vehicleUrls[0].sourceReceiptId;
    await sql.unsafe(
      "UPDATE appfueled_url_receipts SET received_at=now() - interval '31 days' WHERE id=$1",
      [sourceReceiptId],
    );
    const cleaned = await cleanupExpiredAppFueledReceipts(new Date());
    assert.ok(cleaned.receipts >= 1);
    const provenance = await sql.unsafe(
      `SELECT v.source_receipt_id,
              EXISTS(SELECT 1 FROM appfueled_url_receipts r WHERE r.id=v.source_receipt_id) AS receipt_exists
       FROM appfueled_vehicle_urls v WHERE v.connection_id=$1 AND v.vin=$2`,
      [connection.id, VIN],
    );
    assert.equal(provenance[0].source_receipt_id, sourceReceiptId);
    assert.equal(provenance[0].receipt_exists, false,
      "receipt cleanup preserves finite provenance on the durable association");

    await sql.unsafe("CREATE ROLE task1257_anon NOLOGIN NOSUPERUSER NOBYPASSRLS");
    await sql.unsafe("GRANT USAGE ON SCHEMA public TO task1257_anon");
    await sql.unsafe(
      `GRANT SELECT ON appfueled_url_connections,appfueled_url_receipts,
       appfueled_vehicle_urls,appfueled_url_rate_buckets TO task1257_anon`,
    );
    const ownerCount = await sql.unsafe(
      "SELECT count(*)::int AS count FROM appfueled_url_connections",
    );
    assert.equal(ownerCount[0].count, 1, "the owner fixture role can inspect captured data");
    const anonCounts = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE task1257_anon");
      return tx.unsafe(
        `SELECT
          (SELECT count(*)::int FROM appfueled_url_connections) AS connections,
          (SELECT count(*)::int FROM appfueled_url_receipts) AS receipts,
          (SELECT count(*)::int FROM appfueled_vehicle_urls) AS urls,
          (SELECT count(*)::int FROM appfueled_url_rate_buckets) AS buckets`,
      );
    });
    assert.deepEqual(
      [
        anonCounts[0].connections,
        anonCounts[0].receipts,
        anonCounts[0].urls,
        anonCounts[0].buckets,
      ],
      [0, 0, 0, 0],
      "a granted synthetic anon role cannot read sensitive rows through deny-by-default RLS",
    );

    console.log("PASS task1257 real PostgreSQL 16 repository/migration integration (migration applied twice)");
  } finally {
    __deps.getSql = originalGetSql;
    if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
    if (started) {
      try {
        run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], childEnv);
      } catch {
        // Removal below is still attempted; the test's primary assertion error is preserved.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});