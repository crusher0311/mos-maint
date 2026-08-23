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
  const receivedHeader: Buffer[] = [];
  const receivedImage: Buffer[] = [];
  let stage: "setup" | "image" = "setup";
  const setupAck =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<status><code>0</code><comment>print setup accepted</comment></status>";
  const imageAck =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<status><code>0</code><comment>print data received</comment></status>";
  const server = net.createServer((socket) => {
    socket.on("data", (d) => {
      if (stage === "setup") {
        receivedHeader.push(d);
        const setup = Buffer.concat(receivedHeader).toString("utf8");
        if (setup.trimEnd().endsWith("</print>")) {
          stage = "image";
          socket.write(setupAck);
        }
      } else {
        receivedImage.push(d);
        if (Buffer.concat(receivedImage).length >= jpeg.length) {
          socket.write(imageAck);
        }
      }
    });
    socket.on("end", () => socket.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03]);
  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<print>",
    "<mode>vivid</mode>",
    "<speed>0</speed>",
    "<lpi>317</lpi>",
    "<width>0</width>",
    "<height>0</height>",
    "<dataformat>jpeg</dataformat>",
    "<autofit>1</autofit>",
    `<datasize>${jpeg.length}</datasize>`,
    "<cutmode>full</cutmode>",
    "</print>",
  ].join("\n") + "\n";

  await sendToPrinter("127.0.0.1", header, jpeg, { port });

  assert.equal(Buffer.concat(receivedHeader).toString("utf8"), header);
  assert.deepEqual(Buffer.concat(receivedImage), jpeg);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("sendToPrinter does not send JPEG bytes when setup is rejected", async () => {
  let bytesAfterSetup = 0;
  const server = net.createServer((socket) => {
    let replied = false;
    socket.on("data", (d) => {
      if (replied) {
        bytesAfterSetup += d.length;
        return;
      }
      replied = true;
      socket.write(
        "<status><code>7</code><comment>cassette missing</comment></status>",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  await assert.rejects(
    () =>
      sendToPrinter(
        "127.0.0.1",
        "<print><datasize>3</datasize></print>",
        Buffer.from([1, 2, 3]),
        { port },
      ),
    /rejected setup.*cassette missing/,
  );
  assert.equal(bytesAfterSetup, 0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("sendToPrinter reports a terminal image rejection after sending exact bytes", async () => {
  const received: Buffer[] = [];
  let setupAccepted = false;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const server = net.createServer((socket) => {
    socket.on("data", (d) => {
      if (!setupAccepted) {
        setupAccepted = true;
        socket.write("<status><code>0</code><comment>ready</comment></status>");
        return;
      }
      received.push(d);
      if (Buffer.concat(received).length >= jpeg.length) {
        socket.write(
          "<status><code>9</code><comment>invalid print data</comment></status>",
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  await assert.rejects(
    () =>
      sendToPrinter(
        "127.0.0.1",
        "<print><datasize>4</datasize></print>\n",
        jpeg,
        { port },
      ),
    /rejected image.*invalid print data/,
  );
  assert.deepEqual(Buffer.concat(received), jpeg);
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
