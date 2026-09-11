/**
 * Real MongoDB regression for generation replacement.
 *
 * This intentionally starts its own loopback mongod. It must never resolve the
 * application's Mongo URI or exercise a provider client.
 *
 * Run:
 *   NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
 *     npx tsx tests/protractor-generation-replacement.mongo.smoke.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { MongoClient, type Db } from "mongodb";
import {
  __protractorPhysicalTransportTestHooks,
  acquireProtractorPhysicalTransportLease,
  activateProtractorOperatorStop,
  clearProtractorOperatorStop,
  confirmProtractorPhysicalTransportLease,
  getProtractorOperatorStop,
  releaseProtractorPhysicalTransportLease,
  startProtractorTimedTrial,
} from "../lib/data/repositories/api-usage";

const PHYSICAL_KEY = "protractor-physical-transport-v1";
const DATABASE_NAME = "protractor-generation-replacement-smoke";

type LocalMongo = {
  child: ChildProcess;
  client: MongoClient;
  db: Db;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function unusedLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!port) throw new Error("the operating system did not provide an ephemeral port");
  return port;
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (childExited(child)) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function stopMongod(child: ChildProcess): Promise<void> {
  if (childExited(child)) return;
  child.kill("SIGTERM");
  await waitForChildExit(child, 5_000);
  if (!childExited(child)) {
    child.kill("SIGKILL");
    await waitForChildExit(child, 2_000);
  }
}

async function startLocalMongo(dbPath: string, port: number): Promise<LocalMongo> {
  const child = spawn(
    "mongod",
    [
      "--dbpath",
      dbPath,
      "--bind_ip",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", chunk => {
    output += String(chunk);
  });
  child.stderr?.on("data", chunk => {
    output += String(chunk);
  });
  let spawnError: NodeJS.ErrnoException | undefined;
  child.once("error", error => {
    spawnError = error as NodeJS.ErrnoException;
  });

  const uri = `mongodb://127.0.0.1:${port}/${DATABASE_NAME}`;
  let lastConnectError: unknown;
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (spawnError) {
        const detail =
          spawnError.code === "ENOENT"
            ? "mongod was not found on PATH"
            : `mongod failed to spawn (${spawnError.code ?? spawnError.message})`;
        throw new Error(
          `${detail}; this real-Mongo smoke test requires a local mongod (7.0.x is expected)`,
        );
      }
      if (childExited(child)) {
        throw new Error(
          `mongod exited before accepting ${uri}; output:\n${output.slice(-4_000)}`,
        );
      }

      const client = new MongoClient(uri, {
        directConnection: true,
        serverSelectionTimeoutMS: 250,
        connectTimeoutMS: 250,
        retryReads: false,
        retryWrites: false,
      });
      try {
        await client.connect();
        return {
          child,
          client,
          db: client.db(DATABASE_NAME),
        };
      } catch (error) {
        lastConnectError = error;
        await client.close().catch(() => undefined);
        await delay(100);
      }
    }
  } catch (error) {
    await stopMongod(child);
    throw error;
  }

  await stopMongod(child);
  throw new Error(
    `mongod did not become ready at ${uri}; last connection error: ${String(
      lastConnectError,
    )}\noutput:\n${output.slice(-4_000)}`,
  );
}

function dateAt(offsetMs: number): Date {
  return new Date(Date.now() + offsetMs);
}

async function acquire(
  deadlineMs = 5_000,
): Promise<string> {
  const ownerToken = await acquireProtractorPhysicalTransportLease(Date.now() + deadlineMs);
  assert.ok(ownerToken, "the local Mongo admission gate should grant a lease");
  return ownerToken;
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(`${tmpdir()}/protractor-generation-replacement-`);
  let localMongo: LocalMongo | undefined;
  const originalGetDb = __protractorPhysicalTransportTestHooks.getDb;
  const originalRandomUUID = __protractorPhysicalTransportTestHooks.randomUUID;

  try {
    const port = await unusedLoopbackPort();
    localMongo = await startLocalMongo(tempDir, port);
    const localDb = localMongo.db;

    // This is the only database seam used by the production repository. In
    // particular, no MONGODB_URI, app database, or shared client is consulted.
    __protractorPhysicalTransportTestHooks.getDb = async () => localDb;
    let generationSequence = 0;
    __protractorPhysicalTransportTestHooks.randomUUID = () =>
      `mongo-generation-${++generationSequence}`;

    const collection = localDb.collection<any>("api_rate_limits");
    await collection.deleteMany({});

    const oldBoundedStartedAt = dateAt(-20_000);
    const oldBoundedEndedAt = dateAt(-10_000);
    const oldBoundedCanary = {
      generation: "old-bounded-generation",
      mode: "bounded",
      startedAt: oldBoundedStartedAt,
      expiresAt: dateAt(-15_000),
      maxAdmissions: 2,
      consumedAdmissions: 2,
      remainingAdmissions: 0,
      endedBy: "budget",
      endedAt: oldBoundedEndedAt,
      audit: [
        {
          event: "opened",
          at: oldBoundedStartedAt,
          generation: "old-bounded-generation",
          consumedAdmissions: 0,
          remainingAdmissions: 2,
        },
        {
          event: "admitted",
          at: dateAt(-15_500),
          generation: "old-bounded-generation",
          consumedAdmissions: 1,
          remainingAdmissions: 1,
        },
        {
          event: "admitted",
          at: dateAt(-15_100),
          generation: "old-bounded-generation",
          consumedAdmissions: 2,
          remainingAdmissions: 0,
        },
        {
          event: "ended",
          at: oldBoundedEndedAt,
          generation: "old-bounded-generation",
          consumedAdmissions: 2,
          remainingAdmissions: 0,
          endedBy: "budget",
        },
      ],
      staleCanaryField: "must-not-survive-replacement",
    };
    const oldOperatorStop = {
      active: true,
      stopId: "old-stop-id",
      reason: "old containment",
      changedBy: "old-operator",
      activatedAt: dateAt(-30_000),
      updatedAt: dateAt(-20_000),
      staleOperatorStopField: "must-not-survive-replacement",
    };
    await collection.insertOne({
      _id: PHYSICAL_KEY,
      count: 0,
      nextAllowedAt: new Date(0),
      leaseExpiresAt: new Date(0),
      operatorStop: oldOperatorStop,
      canary: oldBoundedCanary,
      canaryHistory: [],
    });

    console.log("Scenario 1: real Mongo archives a bounded terminal before replacement");
    const timedTrial = await startProtractorTimedTrial({
      changedBy: "timed-trial-operator",
      reason: "real Mongo generation replacement",
      expectedStopId: oldOperatorStop.stopId,
    });
    assert.equal(timedTrial.canary?.mode, "timed_trial");
    assert.equal(timedTrial.canary?.requiresCallback, true);
    assert.equal(timedTrial.canary?.maxAdmissions, null);
    assert.equal(timedTrial.canary?.remainingAdmissions, null);

    let current = await collection.findOne({ _id: PHYSICAL_KEY });
    assert.ok(current);
    assert.deepEqual(current.canaryHistory, [oldBoundedCanary]);
    assert.equal(
      current.canary.staleCanaryField,
      undefined,
      "the replacement canary must not inherit unknown fields from the terminal generation",
    );
    assert.equal(
      current.operatorStop.staleOperatorStopField,
      undefined,
      "the replacement operator stop must not inherit unknown fields",
    );
    assert.equal(
      current.operatorStop.activatedAt,
      undefined,
      "old operator-stop activation fields must be removed",
    );
    assert.equal(current.expiresAt, undefined, "the physical record must not retain a TTL expiry");
    assert.ok(current.canary.startedAt instanceof Date);
    assert.ok(current.canary.expiresAt instanceof Date);
    assert.equal(
      current.canary.expiresAt.getTime() - current.canary.startedAt.getTime(),
      1_800_000,
      "$$NOW must produce an exact 30-minute timed-trial window",
    );

    console.log("Scenario 2: real acquire/confirm/release admits callbacks beyond three");
    const startedAt = current.canary.startedAt as Date;
    const staleCallbackAt = new Date(startedAt.getTime() - 1);
    const firstOwner = await acquire();
    assert.equal(
      await confirmProtractorPhysicalTransportLease(firstOwner),
      false,
      "a timed trial must deny a confirmation without callback receipt",
    );
    assert.equal(
      await confirmProtractorPhysicalTransportLease(firstOwner, {
        callbackReceivedAt: staleCallbackAt,
      }),
      false,
      "a callback received before the generation started must be denied",
    );
    assert.equal(
      await confirmProtractorPhysicalTransportLease(firstOwner, {
        callbackReceivedAt: new Date(),
      }),
      true,
      "a callback received during the generation must be admitted",
    );
    await releaseProtractorPhysicalTransportLease(firstOwner);

    for (let admission = 1; admission < 4; admission += 1) {
      const owner = await acquire();
      assert.equal(
        await confirmProtractorPhysicalTransportLease(owner, {
          callbackReceivedAt: new Date(),
        }),
        true,
        `real timed-trial callback admission ${admission + 1} should succeed`,
      );
      await releaseProtractorPhysicalTransportLease(owner);
    }
    current = await collection.findOne({ _id: PHYSICAL_KEY });
    assert.ok(current);
    assert.equal(current.canary.consumedAdmissions, 4);
    assert.equal(
      current.canary.audit.filter((event: any) => event.event === "admitted").length,
      4,
      "the Mongo admission CAS must record all four callback admissions",
    );

    console.log("Scenario 3: an expired timed fixture is terminal and cannot acquire");
    const expiredAt = new Date(Date.now() - 1_000);
    const expiredStartedAt = new Date(expiredAt.getTime() - 1_800_000);
    await collection.updateOne(
      { _id: PHYSICAL_KEY },
      [{ $set: { "canary.startedAt": expiredStartedAt, "canary.expiresAt": expiredAt } }],
    );
    const terminal = await getProtractorOperatorStop();
    assert.equal(terminal.canary?.endedBy, "time");
    assert.equal(terminal.canary?.endedAt?.getTime(), expiredAt.getTime());
    assert.equal(
      await acquire(1_000).catch(() => null),
      null,
      "an expired timed trial must deny new physical admission",
    );

    console.log("Scenario 4: real Mongo archives timed terminal state before bounded replacement");
    const activated = await activateProtractorOperatorStop({
      changedBy: "bounded-operator",
      reason: "close expired timed trial",
    });
    assert.equal(activated.active, true);
    const timedTerminalBeforeClear = (await collection.findOne({ _id: PHYSICAL_KEY }))!.canary;
    assert.equal(timedTerminalBeforeClear.endedBy, "time");
    const bounded = await clearProtractorOperatorStop({
      changedBy: "bounded-operator",
      reason: "bounded replacement",
      expectedStopId: activated.stopId!,
      expiresAt: dateAt(60_000),
      maxAdmissions: 2,
    });
    assert.equal(bounded.canary?.mode, "bounded");
    current = await collection.findOne({ _id: PHYSICAL_KEY });
    assert.ok(current);
    assert.deepEqual(
      current.canaryHistory,
      [oldBoundedCanary, timedTerminalBeforeClear],
      "each valid terminal generation must be archived byte-for-byte as a history object",
    );
    assert.equal(current.canary.mode, "bounded");
    assert.equal(current.canary.consumedAdmissions, 0);
    assert.equal(current.canary.remainingAdmissions, 2);
    assert.equal(current.canary.endedBy, undefined);
    assert.equal(current.canary.endedAt, undefined);
    assert.equal(current.canary.requiresCallback, undefined);
    assert.equal(current.canary.staleCanaryField, undefined);
    assert.equal(current.operatorStop.activatedAt, undefined);
    assert.equal(current.operatorStop.staleOperatorStopField, undefined);
    assert.deepEqual(Object.keys(current.operatorStop).sort(), [
      "active",
      "changedBy",
      "clearedAt",
      "reason",
      "stopId",
      "updatedAt",
    ]);

    console.log("protractor generation replacement Mongo smoke: all checks passed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!localMongo) {
      throw new Error(
        `Unable to run the isolated Mongo regression. Ensure mongod 7.0.x is installed on PATH; ${message}`,
      );
    }
    throw error;
  } finally {
    __protractorPhysicalTransportTestHooks.getDb = originalGetDb;
    __protractorPhysicalTransportTestHooks.randomUUID = originalRandomUUID;
    if (localMongo) {
      await localMongo.client.close().catch(() => undefined);
      await stopMongod(localMongo.child);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});