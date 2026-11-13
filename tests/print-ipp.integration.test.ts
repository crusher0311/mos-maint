import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { MongoClient, ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import * as ipp from "../lib/print-queue/ipp-repository";
import * as legacy from "../lib/print-queue/repository";
import { IPP_PROTOCOL } from "../lib/print-queue/ipp-contract";
import { checkPrintSetup } from "./helpers/print-setup-scenario";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const printer = { id: "ipp-" + "a".repeat(32), name: "Front", model: "ZINK hAppy",
  kind: "sticker", stock: { width: 5080, height: 5080 }, online: true };

test("isolated real Mongo: IPP scoped routing, immutable claims, deduplication and legacy exclusion", { timeout: 60000 }, async () => {
  const listener = net.createServer();
  await new Promise<void>(r => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(r => listener.close(() => r()));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ipp-mongo-"));
  const child = spawn("mongod", ["--dbpath", directory, "--bind_ip", "127.0.0.1", "--port", String(port),
    "--quiet", "--nounixsocket", "--wiredTigerCacheSizeGB", "0.25"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-10000); });
  child.stderr.on("data", () => {});
  const client = new MongoClient(`mongodb://127.0.0.1:${port}`, { serverSelectionTimeoutMS: 500 });
  try {
    const until = Date.now() + 15000;
    while (true) {
      try { await client.connect(); break; }
      catch (error) {
        if (Date.now() > until || child.exitCode !== null) throw new Error("Isolated Mongo did not start: " + logs.slice(-500));
        await new Promise(r => setTimeout(r, 100));
      }
    }
    const db = client.db("isolated_ipp");
    await checkPrintSetup(db);
    ipp.__ippDeps.getDb = async () => db;
    legacy.__deps.getDb = (async () => db) as any;
    const agent = ipp.agentIdentity(1, "key-a", "installation-a");
    const foreign = ipp.agentIdentity(2, "key-a", "installation-a");
    assert.notEqual(agent, foreign);
    assert.notEqual(agent, ipp.agentIdentity(1, "key-b", "installation-a"));
    await ipp.publishInventory(1, agent, [{ ...printer, uri: "ipp://never-leave-agent/", secret: "must-be-dropped" }]);
    const inventory = await db.collection("print_ipp_inventory").findOne({});
    assert.equal(inventory!.printers[0].uri, undefined);
    assert.equal(inventory!.printers[0].secret, undefined);
    const [destination] = await ipp.destinations(1, "sticker");
    assert.equal((await ipp.destinations(2, "sticker")).length, 0);
    await ipp.setDefaultDestination(1, "sticker", destination.id);
    await assert.rejects(ipp.setDefaultDestination(2, "sticker", destination.id));
    assert.equal((await ipp.getDestinationSettings(1, "sticker", true)).defaultDestinationId, destination.id);
    assert.equal((await ipp.getDestinationSettings(2, "sticker", false)).defaultDestinationId, null);
    const input = { type: "sticker", imageBase64: png, stock: printer.stock,
      destinationId: destination.id, revision: destination.revision, printActionId: randomUUID() };
    const [a, b] = await Promise.all([ipp.enqueueIpp(1, input), ipp.enqueueIpp(1, input)]);
    assert.equal(a.jobId, b.jobId);
    assert.equal(await db.collection("print_jobs").countDocuments({}), 1);
    await assert.rejects(ipp.enqueueIpp(2, input));
    await assert.rejects(ipp.enqueueIpp(1, { ...input, revision: "changed" }), /different content/);
    await assert.rejects(ipp.enqueueIpp(1, { ...input, stock: { width: 6000, height: 6000 }, printActionId: randomUUID() }), /stock/);
    assert.equal(await legacy.claimNextJob(1, printer.id), null);
    assert.equal(await legacy.requeueJob(1, a.jobId), "not_found");
    assert.equal(await legacy.clearJob(1, a.jobId), "not_found");
    assert.equal(await legacy.ackJob(1, a.jobId, "success"), "not_found");
    assert.equal(await ipp.pollIpp(2, agent), null);
    assert.equal(await ipp.pollIpp(1, foreign), null);
    const claim = (await ipp.pollIpp(1, agent))!;
    assert.equal(claim.reconcileOnly, false); assert.equal(claim.imageBase64, png);
    const retry = (await ipp.pollIpp(1, agent))!;
    assert.equal(retry.reconcileOnly, true); assert.equal(retry.claimToken, claim.claimToken);
    const ack = { jobId: a.jobId, claimToken: claim.claimToken, status: "printer-accepted", printerJobId: 42 };
    await assert.rejects(ipp.ackIpp(2, agent, ack), /not found/);
    await assert.rejects(ipp.ackIpp(1, foreign, ack), /not found/);
    await assert.rejects(ipp.ackIpp(1, agent, { ...ack, claimToken: "wrong" }), /not found/);
    await ipp.ackIpp(1, agent, ack);
    await ipp.ackIpp(1, agent, ack); // Lost cloud ack can be repeated without printer work.
    await assert.rejects(ipp.ackIpp(1, agent, { ...ack, printerJobId: 43 }), /identity conflict/);
    await ipp.ackIpp(1, agent, { ...ack, status: "unknown" });
    assert.equal((await ipp.getIppStatus(1, a.jobId)).status, "printer-accepted");
    await assert.rejects(ipp.getIppStatus(2, a.jobId), /not found/);
    await assert.rejects(ipp.getIppStatus(1, a.jobId, "keytag"), /not found/);
    await ipp.ackIpp(1, agent, { ...ack, status: "completed" });
    await ipp.ackIpp(1, agent, { ...ack, status: "failed" });
    assert.equal((await ipp.getIppStatus(1, a.jobId)).status, "completed");
    assert.equal(await ipp.pollIpp(1, agent), null);
    // Removing inventory does not quietly replace the saved default.
    await ipp.publishInventory(1, agent, []);
    const removed = await ipp.getDestinationSettings(1, "sticker", true);
    assert.equal(removed.defaultDestinationId, destination.id); assert.equal(removed.destinations.length, 0);
    await assert.rejects(ipp.enqueueIpp(1, { ...input, printActionId: randomUUID() }), /removed/);
    assert.equal((await ipp.enqueueIpp(1, input)).jobId, a.jobId); // Same action still deduplicates.
    await ipp.publishInventory(1, agent, [{ ...printer, online: false }]);
    await assert.rejects(ipp.enqueueIpp(1, { ...input, printActionId: randomUUID() }), /offline/);
    await ipp.publishInventory(1, agent, [printer]);
    const stale = await ipp.enqueueIpp(1, { ...input, printActionId: randomUUID() });
    const staleClaim = (await ipp.pollIpp(1, agent))!;
    await db.collection("print_jobs").updateOne({ _id: new ObjectId(stale.jobId) }, { $set: { claimedAt: new Date(0) } });
    assert.equal((await ipp.getIppStatus(1, stale.jobId)).status, "unknown");
    const stalePoll = (await ipp.pollIpp(1, agent))!;
    assert.equal(stalePoll.claimToken, staleClaim.claimToken); assert.equal(stalePoll.reconcileOnly, true);
    assert.equal((await db.collection("print_jobs").findOne({ _id: new ObjectId(stale.jobId) }))!.protocol, IPP_PROTOCOL);
    // Legacy queue jobs still deliver through the old contract.
    const old = await legacy.enqueuePrintJob({ shopId: 3, imageBase64: "jpeg", kind: "raw" });
    assert.equal((await legacy.claimNextJob(3))!.id, old);
  } finally {
    await client.close();
    child.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
