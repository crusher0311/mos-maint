import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { MongoClient } from "mongodb";
import { fleetHistoryDefaults, type FleetHistoryPermit } from "../lib/integrations/protractor/fleet-history-policy";
import { __fleetHistoryDeps, fleetHistoryStatus, saveFleetHistoryConfig, controlFleetHistory, runFleetHistoryTick } from "../lib/integrations/protractor/fleet-history";
import { assertFleetHistoryContext, getFleetHistoryContext } from "../lib/integrations/protractor/fleet-history-context";
import { connectionBinding } from "../lib/integrations/protractor/connection-identity";
import { __protractorPhysicalTransportTestHooks, confirmProtractorPhysicalTransportLease } from "../lib/data/repositories/api-usage";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function main() {
  const server = net.createServer();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(r => server.close(() => r()));
  const path = await mkdtemp(`${tmpdir()}/fleet-history-`);
  const proc = spawn("mongod", ["--dbpath", path, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/fleet_history_test`, { serverSelectionTimeoutMS: 500, retryWrites: false });
  try {
    for (let i = 0; ; i++) { try { await client.connect(); break; } catch (e) { if (i === 30) throw e; await sleep(100); } }
    const db = client.db(), rates = db.collection<any>("api_rate_limits"), shops = db.collection("shops");
    const key = "protractor-physical-transport-v1";
    __fleetHistoryDeps.getDb = async () => db;
    __protractorPhysicalTransportTestHooks.getDb = async () => db;
    __fleetHistoryDeps.findProgressForShops = async () => [];
    __fleetHistoryDeps.findByShop = async () => null;
    await rates.insertOne({ _id: key, operatorStop: { active: false }, canary: {
      mode: "live", generation: "g", scope: "callbacks_and_interactive", requiresCallback: false,
      requiresRelay: true, workersSuspendedConfirmed: true, startedAt: new Date(Date.now() - 60000),
      maxAdmissions: null, remainingAdmissions: null, consumedAdmissions: 0, audit: [],
    } });
    const config = fleetHistoryDefaults();
    config.enabled = true; config.defaultTimezone = "UTC";
    config.week.forEach(d => { d.closed = true; });
    await assert.rejects(() => saveFleetHistoryConfig(config, false));
    const saved = await saveFleetHistoryConfig(config, true);
    await assert.rejects(() => saveFleetHistoryConfig(config, true)); // stale revision
    const binding = connectionBinding("original-account", "fixture-key");
    await shops.insertOne({ shopId: 1, integrationProvider: "protractor", protractorConnectionId: "original-account",
      protractorApiKey: "fixture-key", protractor: { configured: true, connectionGeneration: binding } });
    let calls = 0;
    __fleetHistoryDeps.runBackfill = async (id) => {
      calls++;
      await assertFleetHistoryContext(id, "original-account");
      const permit = getFleetHistoryContext()!;
      const resetAdmission = async () => rates.updateOne({ _id: key }, { $set: {
        ownerToken: "physical", ownerCanaryGeneration: "g", leaseExpiresAt: new Date(Date.now() + 60000),
      }, $unset: { physicalAdmissionOwnerToken: "" } });
      await resetAdmission();
      assert.equal(await confirmProtractorPhysicalTransportLease("physical", { fleetHistory: permit, requireTimedTrial: true, environment: "production", transport: "relay" }), true);
      assert.equal((await rates.findOne({ _id: key }))!.fleetHistoryGrant.consumed, 1);
      await resetAdmission();
      assert.equal(await confirmProtractorPhysicalTransportLease("physical", { fleetHistory: { ...permit, shopId: 2 }, environment: "production", transport: "relay" }), false);
      assert.equal(await confirmProtractorPhysicalTransportLease("physical", { fleetHistory: permit, environment: "development", transport: "relay" }), false);
      assert.equal(await confirmProtractorPhysicalTransportLease("physical", { fleetHistory: permit, environment: "production", transport: "direct" }), false);
      await controlFleetHistory(id, "pause");
      await assert.rejects(() => assertFleetHistoryContext(id));
      assert.equal(await confirmProtractorPhysicalTransportLease("physical", { fleetHistory: permit, environment: "production", transport: "relay" }), false);
      return { chunksProcessed: 1, totalJobsIndexed: 0, complete: false };
    };
    const checkRun = __fleetHistoryDeps.runBackfill;
    let runFailure: unknown;
    __fleetHistoryDeps.runBackfill = async id => {
      try { return await checkRun(id); } catch (e) { runFailure = e; throw e; }
    };
    assert.equal((await runFleetHistoryTick()).processed, 1);
    if (runFailure) throw runFailure;
    assert.equal(calls, 1);
    assert.equal((await fleetHistoryStatus()).shops[0].paused, true);
    assert.equal((await runFleetHistoryTick()).processed, 0);
    await controlFleetHistory(1, "retry");
    __fleetHistoryDeps.findByShop = async () => ({ shopId: 1, inProgress: true } as any);
    assert.equal((await runFleetHistoryTick()).processed, 0);
    assert.equal(calls, 1, "active progress must never be stolen");
    __fleetHistoryDeps.findByShop = async () => ({ shopId: 1, inProgress: true, lastActivityAt: new Date(Date.now() - 31 * 60000) } as any);
    assert.equal((await runFleetHistoryTick()).processed, 1);
    if (runFailure) throw runFailure;
    assert.equal(calls, 2, "stale runs reach the canonical engine's atomic lease claim");
    await controlFleetHistory(1, "resume");
    await shops.updateOne({ shopId: 1 }, { $set: { "protractor.checkpointWriteToken": "still-owned" } });
    assert.equal((await runFleetHistoryTick()).processed, 0);
    assert.equal(calls, 2, "checkpoint mutex must never be cleared based on age");
    await saveFleetHistoryConfig({ ...saved, enabled: false }, true);
    assert.equal((await runFleetHistoryTick()).processed, 0);
    console.log("Real Mongo fleet controls, revision CAS, worker admission, isolation, relay boundary, pause and active-progress safety passed");
  } finally {
    await client.close(); proc.kill("SIGTERM");
    await new Promise<void>(r => proc.exitCode !== null ? r() : proc.once("exit", () => r()));
    await rm(path, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
