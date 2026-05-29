import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  isIpAddress,
  isMdnsName,
  resolveAddress,
  sendToPrinter,
} from "../src/printer";

test("isIpAddress recognizes IPv4 and IPv6 literals", () => {
  assert.equal(isIpAddress("192.168.1.50"), true);
  assert.equal(isIpAddress("10.0.0.1"), true);
  assert.equal(isIpAddress("255.255.255.255"), true);
  assert.equal(isIpAddress("::1"), true);
  assert.equal(isIpAddress("fe80::1"), true);
  assert.equal(isIpAddress("zink.local"), false);
  assert.equal(isIpAddress("printer.shop.lan"), false);
  assert.equal(isIpAddress("999.1.1.1"), false);
});

test("isMdnsName recognizes .local names", () => {
  assert.equal(isMdnsName("zink.local"), true);
  assert.equal(isMdnsName("zink.local."), true);
  assert.equal(isMdnsName("ZINK.LOCAL"), true);
  assert.equal(isMdnsName("192.168.1.1"), false);
  assert.equal(isMdnsName("printer.shop.lan"), false);
});

test("resolveAddress returns IP literals untouched (no mDNS call)", async () => {
  let called = false;
  const out = await resolveAddress("192.168.1.42", {
    mdnsResolver: async () => {
      called = true;
      return "should-not-be-used";
    },
  });
  assert.equal(out, "192.168.1.42");
  assert.equal(called, false);
});

test("resolveAddress routes .local names through the mDNS resolver", async () => {
  const out = await resolveAddress("zink.local", {
    mdnsResolver: async (hostname, timeoutMs) => {
      assert.equal(hostname, "zink.local");
      assert.equal(timeoutMs, 1234);
      return "192.168.1.77";
    },
    timeoutMs: 1234,
  });
  assert.equal(out, "192.168.1.77");
});

test("resolveAddress passes plain hostnames through untouched", async () => {
  let called = false;
  const out = await resolveAddress("printer.shop.lan", {
    mdnsResolver: async () => {
      called = true;
      return "x";
    },
  });
  assert.equal(out, "printer.shop.lan");
  assert.equal(called, false);
});

test("resolveAddress rejects empty address", async () => {
  await assert.rejects(() => resolveAddress("  "), /empty/);
});

test("resolveAddress propagates mDNS timeout errors", async () => {
  await assert.rejects(
    () =>
      resolveAddress("zink.local", {
        mdnsResolver: async () => {
          throw new Error("mDNS resolution timed out");
        },
      }),
    /timed out/,
  );
});

test("sendToPrinter writes header then JPEG bytes over the socket", async () => {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (d) => received.push(d));
    socket.on("end", () => socket.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  const header = "<print><width>640</width><cut>1</cut><speed>0</speed></print>";
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03]);

  await sendToPrinter("127.0.0.1", header, jpeg, { port });

  const all = Buffer.concat(received);
  assert.ok(all.length >= header.length + jpeg.length);
  assert.equal(all.subarray(0, header.length).toString("utf8"), header);
  assert.deepEqual(all.subarray(header.length), jpeg);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("sendToPrinter rejects when the printer is unreachable", async () => {
  // Reserved TEST-NET-1 address that should not be connectable; short timeout.
  await assert.rejects(
    () =>
      sendToPrinter("192.0.2.1", "hdr", Buffer.from([0x00]), {
        port: 9100,
        connectTimeoutMs: 300,
      }),
    /timed out|ECONN|EHOSTUNREACH|ENETUNREACH/,
  );
});
