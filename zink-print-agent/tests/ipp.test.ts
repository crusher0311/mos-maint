import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Tag, encodeRequest, decodeReply, groupValues, MAX_REPLY_BYTES, type Attributes, type Values } from "../src/ipp/codec";
import { IppClient, validatePng, type EnrolledPrinter } from "../src/ipp/client";
import { selectMedia } from "../src/ipp/media";
import { IppJournal, IppWorker, type IppJob } from "../src/ipp/journal";
import { createExchange, printerUrl } from "../src/ipp/transport";
import { discoverPrinters, type DiscoverySocket } from "../src/ipp/discovery";
import { EnrollmentStore } from "../src/ipp/enrollment";

const stock = { width: 5000, height: 5000 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const media: Attributes = {
  "media-size": { tag: Tag.collection, value: {
    "x-dimension": { tag: Tag.integer, value: 5000 },
    "y-dimension": { tag: Tag.integer, value: 5000 },
  } },
  ...Object.fromEntries(["left", "right", "top", "bottom"].map(side =>
    [`media-${side}-margin`, { tag: Tag.integer, value: 0 }])),
};
const capabilities: Attributes = {
  "printer-uuid": { tag: Tag.uri, value: "urn:uuid:12345678-1234-1234-1234-123456789abc" },
  "printer-make-and-model": { tag: Tag.text, value: "ZINK hAppy" },
  "document-format-supported": { tag: Tag.mime, value: "image/png" },
  "operations-supported": [{ tag: Tag.enum, value: 2 }, { tag: Tag.enum, value: 9 }],
  "print-scaling-supported": { tag: Tag.keyword, value: "none" },
  "printer-is-accepting-jobs": { tag: Tag.boolean, value: true },
  "printer-state": { tag: Tag.enum, value: 3 },
  "media-col-database": { tag: Tag.collection, value: media },
};
function values(attrs: Attributes): Values {
  return groupValues(decodeReply(encodeRequest(0, 1, [{ tag: 4, values: attrs }])), 4);
}
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "mos-ipp-")); }
async function fakeClient(onSubmit: () => void = () => {}, state = 3) {
  const client = new IppClient(async (_uri, operation, _groups, document) => {
    if (operation === 0x0b) return decodeReply(encodeRequest(0, 1, [{ tag: 4, values: capabilities }]));
    onSubmit();
    if (operation === 2) assert.deepEqual(document, png, "PNG must not be re-encoded");
    return decodeReply(encodeRequest(0, 1, [{ tag: 2, values: {
      "job-id": { tag: Tag.integer, value: 42 }, "job-state": { tag: Tag.enum, value: state },
    } }]));
  });
  const printer = await client.enroll("ipp://printer.local/ipp/print", "Front counter", "sticker", stock);
  return { client, printer };
}
function job(printer: EnrolledPrinter, id = "job-1"): IppJob {
  return { id, printerId: printer.id, png, kind: "sticker", stock };
}

test("IPP round-trip retains media collections, repeated values, and no-scaling", () => {
  const attrs = values(capabilities);
  const selected = selectMedia(attrs, stock, stock);
  const roundTrip = values(selected.attributes);
  assert.equal(roundTrip["print-scaling"][0], "none");
  assert.deepEqual(attrs["operations-supported"], [2, 9]);
  const col = roundTrip["media-col"][0] as Values;
  const size = col["media-size"][0] as Values;
  assert.equal(size["x-dimension"][0], 5000);
  assert.equal(size["y-dimension"][0], 5000);
});

test("decoder rejects truncated, oversized, mismatched and unbounded collections", () => {
  const wire = encodeRequest(0, 8, [{ tag: 4, values: capabilities }]);
  for (let n = 0; n < wire.length; n++) assert.throws(() => decodeReply(wire.subarray(0, n)));
  assert.throws(() => decodeReply(wire, 7), /ID mismatch/);
  assert.throws(() => decodeReply(Buffer.alloc(MAX_REPLY_BYTES + 1)), /length/);
  let deep: Attributes = {};
  for (let i = 0; i < 10; i++) deep = { child: { tag: Tag.collection, value: deep } };
  assert.throws(() => encodeRequest(0, 1, [{ tag: 4, values: deep }]), /too deep/);
});

test("PNG is preserved and corrupt, non-PNG, or mismatched geometry is rejected", () => {
  validatePng(png, stock);
  const bad = Buffer.from(png); bad[40] ^= 1;
  assert.throws(() => validatePng(bad, stock), /checksum/);
  assert.throws(() => validatePng(Buffer.from("JPEG"), stock), /PNG/);
  assert.throws(() => validatePng(png, { width: 5000, height: 10000 }), /aspect ratio/);
  assert.throws(() => validatePng(png, { width: NaN, height: 10000 }), /dimensions/);
});

test("stock, PNG, margins and no-scaling support fail closed", () => {
  assert.throws(() => selectMedia(values(capabilities), stock, { width: 5100, height: 5000 }), /stock/);
  for (const key of ["document-format-supported", "print-scaling-supported", "media-col-database"]) {
    const attrs = values(capabilities); delete attrs[key];
    assert.throws(() => selectMedia(attrs, stock, stock));
  }
  const attrs = values(capabilities);
  (attrs["media-col-database"][0] as Values)["media-left-margin"] = [100];
  assert.throws(() => selectMedia(attrs, stock, stock), /borderless/);
});

test("explicit enrollment has stable identity and unsupported keytags remain blocked", async () => {
  const { client, printer } = await fakeClient();
  const renamed = await client.enroll("ipps://elsewhere.local/ipp/print", "Other name", "sticker", stock);
  assert.equal(renamed.id, printer.id);
  await assert.rejects(client.enroll(printer.uri, "Keytag", "keytag", stock), /Unsupported/);
});

test("initial acceptance is not completion; only job-state 9 establishes completion", async () => {
  for (const state of [3, 5, 9]) {
    const { client, printer } = await fakeClient(undefined, state);
    const result = await client.submit(printer, png, (await client.prepare(printer, png, stock)));
    assert.equal(result.outcome, state === 9 ? "completed" : "printer-accepted");
  }
});

test("lost printer response and substituted attributes remain unknown", async () => {
  const { printer } = await fakeClient();
  const lost = new IppClient(async () => { throw new Error("lost"); });
  assert.equal((await lost.submit(printer, png, {})).outcome, "unknown");
  const substituted = new IppClient(async () => decodeReply(encodeRequest(1, 1, [])));
  assert.equal((await substituted.submit(printer, png, {})).outcome, "unknown");
});

test("concurrent duplicate logical submissions and restart send PNG only once", async () => {
  let sends = 0;
  const { client, printer } = await fakeClient(() => sends++);
  const directory = temp();
  try {
    const worker = new IppWorker([printer], new IppJournal(directory, "shop-1/agent-1"), client);
    const results = await Promise.all([worker.process(job(printer)), worker.process(job(printer))]);
    assert.equal(sends, 1); assert.equal(results[0].outcome, "printer-accepted");
    const restarted = new IppWorker([printer], new IppJournal(directory, "shop-1/agent-1"), client);
    assert.equal((await restarted.process(job(printer))).outcome, "printer-accepted");
    assert.equal(sends, 1);
    const conflict = job(printer); conflict.stock = { width: 6000, height: 5000 };
    assert.equal((await restarted.process(conflict)).outcome, "unknown");
    assert.equal(sends, 1);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("sending marker survives interruption and never resubmits; unknown route never falls back", async () => {
  let sends = 0;
  const { client, printer } = await fakeClient(() => sends++);
  const directory = temp();
  try {
    const journal = new IppJournal(directory, "shop-1");
    journal.begin(job(printer));
    const worker = new IppWorker([printer], journal, client);
    assert.equal((await worker.process(job(printer))).outcome, "unknown");
    assert.equal((await worker.process({ ...job(printer, "job-2"), printerId: "removed" })).outcome, "failed");
    assert.equal(sends, 0);
    assert.equal(new IppJournal(directory, "shop-2").read(job(printer)), undefined);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("process-wide printer lock blocks different jobs until explicitly released", async () => {
  const { client, printer } = await fakeClient();
  const directory = temp();
  try {
    const journal = new IppJournal(directory, "shop-1");
    const release = journal.acquirePrinter(printer.id)!;
    const worker = new IppWorker([printer], journal, client);
    assert.equal((await worker.process(job(printer))).outcome, "failed");
    release();
    assert.equal((await worker.process(job(printer))).outcome, "printer-accepted");
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("real loopback transport is bounded, sends no auth, and does not follow redirects", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, undefined);
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/print" }); res.end(); return;
      }
      res.writeHead(200, { "Content-Type": "application/ipp" });
      res.end(encodeRequest(0, body.readInt32BE(4), [{ tag: 4, values: capabilities }]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const exchange = createExchange(1000);
    const result = await exchange(`ipp://127.0.0.1:${port}/print`, 0x0b, []);
    assert.equal(result.status, 0);
    await assert.rejects(exchange(`ipp://127.0.0.1:${port}/redirect`, 2, [], png), /non-IPP/);
    assert.equal(calls, 2);
    assert.throws(() => printerUrl("http://localhost/"), /IPP/);
    assert.throws(() => printerUrl("ipp://user:password@localhost/"), /credentials/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("discovery is bounded and yields candidates only, without opening printers", async () => {
  let callback: Function = () => {}, destroyed = false;
  const queries: unknown[] = [];
  const socket = {
    on(event: string, cb: Function) { if (event === "response") callback = cb; },
    query(packet: unknown) {
      queries.push(packet);
      if (queries.length !== 1) return;
      queueMicrotask(() => callback({ answers: [
        { name: "_ipp._tcp.local", type: "PTR", data: "ZINK._ipp._tcp.local" },
        { name: "ZINK._ipp._tcp.local", type: "SRV", data: { target: "zink.local", port: 631 } },
        { name: "ZINK._ipp._tcp.local", type: "TXT", data: [Buffer.from("rp=ipp/print")] },
        { name: "Evil._ipp._tcp.local", type: "SRV", data: { target: "external.example", port: 80 } },
      ] }));
    },
    destroy() { destroyed = true; },
  } as DiscoverySocket;
  const candidates = await discoverPrinters(100, () => socket);
  assert.deepEqual(candidates, [{ service: "zink._ipp._tcp.local", uri: "ipp://zink.local:631/ipp/print" }]);
  assert.equal(destroyed, true); assert.equal(queries.length, 2);
  assert.throws(() => discoverPrinters(60000), /100–10000/);
});

test("enrollment persists names and stock, removes exact identity, and rejects damaged files", async () => {
  const directory = temp();
  try {
    const filename = path.join(directory, "printers.json");
    const store = new EnrollmentStore(filename);
    const { client, printer } = await fakeClient();
    assert.deepEqual(store.list(), []);
    await store.enroll({ uri: printer.uri, name: printer.name, kind: "sticker", stock }, client);
    assert.deepEqual(new EnrollmentStore(filename).list(), [printer]);
    await store.enroll({ uri: printer.uri, name: "Renamed", kind: "sticker", stock }, client);
    assert.equal(store.list().length, 1); assert.equal(store.list()[0].name, "Renamed");
    assert.throws(() => store.remove("unknown"), /Unknown/);
    store.remove(printer.id); assert.deepEqual(store.list(), []);
    fs.writeFileSync(filename, "bad");
    assert.throws(() => store.list());
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("multiple enrolled printers route by identity and distinct jobs serialize", async () => {
  const first = await fakeClient();
  const second = { ...first.printer, id: "ipp-second", name: "Back counter" };
  const seen: string[] = []; let active = 0, maxActive = 0;
  const client = {
    async prepare() { return {}; },
    async submit(printer: EnrolledPrinter) {
      seen.push(printer.id); active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return { outcome: "printer-accepted" as const, printerJobId: 1 };
    },
  } as unknown as IppClient;
  const directory = temp();
  try {
    const worker = new IppWorker([first.printer, second], new IppJournal(directory, "shop"), client);
    await Promise.all([worker.process(job(first.printer)), worker.process(job(second, "job-2"))]);
    assert.deepEqual(seen, [first.printer.id, second.id]); assert.equal(maxActive, 1);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("unwritable journal prevents physical submission", async () => {
  let sends = 0;
  const { client, printer } = await fakeClient(() => sends++);
  const directory = temp();
  try {
    const journal = new IppJournal(directory, "shop");
    const worker = new IppWorker([printer], journal, client);
    // Remove the directory after construction, before any send.
    fs.rmdirSync(directory);
    await assert.rejects(worker.process(job(printer)));
    assert.equal(sends, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("changed physical identity cannot receive a previously enrolled route", async () => {
  const { client, printer } = await fakeClient();
  await assert.rejects(client.prepare({ ...printer, uuid: "urn:uuid:foreign" }, png, stock), /identity changed/);
});

test("a real printer losing the response receives only one request", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++; req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/ipp", "Content-Length": "100" });
      res.write(Buffer.from([2, 0])); setTimeout(() => res.destroy(), 10);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const { printer } = await fakeClient();
    const client = new IppClient(createExchange(1000));
    const evidence = await client.submit({ ...printer, uri: `ipp://127.0.0.1:${port}/print` }, png, {});
    assert.equal(evidence.outcome, "unknown"); assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
