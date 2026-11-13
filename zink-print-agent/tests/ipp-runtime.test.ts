import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IppRuntime, revision } from "../src/ipp/runtime";
import { IppClient, type EnrolledPrinter } from "../src/ipp/client";
import type { AgentConfig } from "../src/config";

test("cloud response loss reconciles after restart without physical resubmission", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ipp-runtime-"));
  const printer: EnrolledPrinter = { id: "ipp-" + "a".repeat(32), name: "Front", model: "ZINK hAppy",
    uuid: "urn:uuid:12345678-1234-1234-1234-123456789abc", kind: "sticker",
    uri: "ipp://fixture.local/ipp/print", stock: { width: 5080, height: 5080 } };
  const enrollmentFile = path.join(directory, "printers.json");
  fs.writeFileSync(enrollmentFile, JSON.stringify({ version: 1, printers: [printer] }));
  const config: AgentConfig = { cloudBaseUrl: "https://fixture.invalid", shopApiKey: "test-only",
    printer: { address: "unused", port: 9100 }, pollIntervalMs: 5000, mdnsTimeoutMs: 100, connectTimeoutMs: 100,
    ipp: { installationId: "fixture-install", enrollmentFile, journalDirectory: path.join(directory, "journal") } };
  let sends = 0, polls = 0, acknowledgments = 0;
  const client = {
    inspect: async () => ({ "printer-uuid": [printer.uuid], "printer-is-accepting-jobs": [true], "printer-state": [3] }),
    prepare: async () => ({}),
    submit: async () => { sends++; return { outcome: "printer-accepted", printerJobId: 12 }; },
    status: async () => ({ outcome: "completed", printerJobId: 12 }),
  } as unknown as IppClient;
  const cloud = { async ippControl(body: any) {
    if (body.action === "ack") {
      acknowledgments++;
      if (acknowledgments === 1) throw new Error("lost ack response");
      assert.equal(body.status, "completed");
      return { ok: true };
    }
    assert.equal(body.printers[0].uri, undefined);
    polls++;
    return { jobs: [{ id: "a".repeat(24), protocol: "mos-ipp-png-v1", printerId: printer.id,
      claimToken: "fixed-fence", kind: printer.kind, stock: printer.stock, revision: revision(printer),
      reconcileOnly: polls > 1, imageBase64: "cG5n" }] };
  } };
  try {
    const reported: any[] = [];
    const noJobs = { async ippControl(body: any) {
      assert.equal(body.printers[0].online, false);
      assert.equal(body.printers[0].reason, undefined);
      return { jobs: [] };
    } };
    const unavailable = { inspect: async () => { throw Error("private printer address"); } } as unknown as IppClient;
    const offline = new IppRuntime(config, noJobs, unavailable, status => reported.push(status));
    await offline.runOnce();
    await offline.runOnce();
    assert.deepEqual(reported, [{ printerNumber: 1, reason: "attributes_failed" }]);
    assert(!JSON.stringify(reported).includes("private"));
    await assert.rejects(new IppRuntime(config, cloud, client).runOnce(), /lost ack/);
    await new IppRuntime(config, cloud, client).runOnce();
    assert.equal(sends, 1); assert.equal(acknowledgments, 2);
    // A previously delivered claim without local evidence MUST NOT be sent.
    fs.rmSync(config.ipp!.journalDirectory, { recursive: true });
    const recovery = { async ippControl(body: any) {
      if (body.action === "ack") { assert.equal(body.status, "unknown"); return { ok: true }; }
      return cloud.ippControl(body);
    } };
    await new IppRuntime(config, recovery, client).runOnce();
    assert.equal(sends, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
