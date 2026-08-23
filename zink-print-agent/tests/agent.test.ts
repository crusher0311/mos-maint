import { test } from "node:test";
import assert from "node:assert/strict";
import { PrintAgent, type AgentRuntimeConfig, type CloudPort, type PrinterPort } from "../src/agent";
import type { AckJobRequest, PrintJob } from "../src/contract";
import { createLogger } from "../src/logger";
import { VALID_JPEG_BASE64, VALID_JPEG_BYTES } from "./fixtures/jpeg";
import { MAX_IMAGE_INPUT_CHARS } from "../src/limits";

const QUIET = createLogger("error");

const CFG: AgentRuntimeConfig = {
  printer: { address: "zink.local", port: 9100 },
  pollIntervalMs: 10,
  mdnsTimeoutMs: 100,
  connectTimeoutMs: 100,
  agentVersion: "test",
};

function makePrinter(overrides: Partial<PrinterPort> = {}): {
  port: PrinterPort;
  sends: Array<{ host: string; header: string; bytes: number }>;
} {
  const sends: Array<{ host: string; header: string; bytes: number }> = [];
  const port: PrinterPort = {
    resolveAddress: overrides.resolveAddress ?? (async (addr) => (addr === "zink.local" ? "192.168.1.5" : addr)),
    sendToPrinter:
      overrides.sendToPrinter ??
      (async (host, header, jpeg) => {
        sends.push({ host, header, bytes: jpeg.length });
      }),
  };
  return { port, sends };
}

const JOB: PrintJob = {
  id: "job-1",
  imageBase64: VALID_JPEG_BASE64,
};

test("processJob resolves, prints, and acks success", async () => {
  const acks: Array<{ id: string; ack: AckJobRequest }> = [];
  const cloud: CloudPort = {
    pollJobs: async () => [],
    ackJob: async (id, ack) => acks.push({ id, ack }),
  };
  const { port, sends } = makePrinter();
  const agent = new PrintAgent(CFG, { cloud, printer: port, logger: QUIET });

  const ok = await agent.processJob(JOB);

  assert.equal(ok, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].host, "192.168.1.5");
  assert.match(sends[0].header, /<mode>vivid<\/mode>/);
  assert.match(
    sends[0].header,
    new RegExp(`<datasize>${VALID_JPEG_BYTES.length}</datasize>`),
  );
  assert.match(sends[0].header, /<cutmode>full<\/cutmode>/);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].ack.status, "success");
});

test("processJob acks failure and never throws when the printer is offline", async () => {
  const acks: Array<{ id: string; ack: AckJobRequest }> = [];
  const cloud: CloudPort = {
    pollJobs: async () => [],
    ackJob: async (id, ack) => acks.push({ id, ack }),
  };
  const { port } = makePrinter({
    sendToPrinter: async () => {
      throw new Error("printer offline: ECONNREFUSED");
    },
  });
  const agent = new PrintAgent(CFG, { cloud, printer: port, logger: QUIET });

  const ok = await agent.processJob(JOB);

  assert.equal(ok, false);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].ack.status, "failure");
  assert.match(acks[0].ack.error ?? "", /offline/);
});

test("processJob survives an mDNS resolution timeout", async () => {
  const acks: Array<{ id: string; ack: AckJobRequest }> = [];
  const cloud: CloudPort = {
    pollJobs: async () => [],
    ackJob: async (id, ack) => acks.push({ id, ack }),
  };
  const { port, sends } = makePrinter({
    resolveAddress: async () => {
      throw new Error("mDNS resolution for \"zink.local\" timed out after 100ms");
    },
  });
  const agent = new PrintAgent(CFG, { cloud, printer: port, logger: QUIET });

  const ok = await agent.processJob(JOB);

  assert.equal(ok, false);
  assert.equal(sends.length, 0);
  assert.match(acks[0].ack.error ?? "", /timed out/);
});

test("processJob ignores a hostile cloud printer override", async () => {
  const acks: Array<{ id: string; ack: AckJobRequest }> = [];
  const cloud: CloudPort = {
    pollJobs: async () => [],
    ackJob: async (id, ack) => acks.push({ id, ack }),
  };
  const resolvedAddrs: string[] = [];
  let usedPort = 0;
  const port: PrinterPort = {
    resolveAddress: async (addr) => {
      resolvedAddrs.push(addr);
      return "192.168.1.5";
    },
    sendToPrinter: async (_host, _header, _jpeg, opts) => {
      usedPort = opts.port;
    },
  };
  const agent = new PrintAgent(CFG, { cloud, printer: port, logger: QUIET });

  await agent.processJob({
    ...JOB,
    // Deliberately simulate an unexpected field from an old/malicious server.
    printer: { address: "10.0.0.9", port: 9200 },
  } as PrintJob & { printer: { address: string; port: number } });

  assert.deepEqual(resolvedAddrs, ["zink.local"]);
  assert.equal(usedPort, 9100);
  assert.equal(acks[0].ack.status, "success");
});

test("processJob rejects malformed JPEG before resolving or opening a socket", async () => {
  const acks: Array<{ id: string; ack: AckJobRequest }> = [];
  const cloud: CloudPort = {
    pollJobs: async () => [],
    ackJob: async (id, ack) => acks.push({ id, ack }),
  };
  let resolutions = 0;
  let sends = 0;
  const port: PrinterPort = {
    resolveAddress: async () => {
      resolutions += 1;
      return "192.168.1.5";
    },
    sendToPrinter: async () => {
      sends += 1;
    },
  };
  const agent = new PrintAgent(CFG, { cloud, printer: port, logger: QUIET });

  const ok = await agent.processJob({
    ...JOB,
    // SOI + superficially valid SOS + EOI, but no frame or entropy stream.
    imageBase64: Buffer.from([
      0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00, 0xff, 0xd9,
    ]).toString("base64"),
  });

  assert.equal(ok, false);
  assert.equal(resolutions, 0);
  assert.equal(sends, 0);
  assert.equal(acks[0].ack.status, "failure");
  assert.match(acks[0].ack.error ?? "", /not a valid JPEG/);
});

test("processJob rejects an oversized encoded image before LAN activity", async () => {
  const acks: Array<{ id: string; ack: AckJobRequest }> = [];
  let resolutions = 0;
  let sends = 0;
  const agent = new PrintAgent(CFG, {
    cloud: {
      pollJobs: async () => [],
      ackJob: async (id, ack) => acks.push({ id, ack }),
    },
    printer: {
      resolveAddress: async () => {
        resolutions += 1;
        return "192.168.1.5";
      },
      sendToPrinter: async () => {
        sends += 1;
      },
    },
    logger: QUIET,
  });

  const ok = await agent.processJob({
    ...JOB,
    imageBase64: "A".repeat(MAX_IMAGE_INPUT_CHARS + 1),
  });

  assert.equal(ok, false);
  assert.equal(resolutions, 0);
  assert.equal(sends, 0);
  assert.equal(acks[0].ack.status, "failure");
  assert.match(acks[0].ack.error ?? "", /encoded size limit/);
});

test("processJob does not throw even if the ack itself fails", async () => {
  const cloud: CloudPort = {
    pollJobs: async () => [],
    ackJob: async () => {
      throw new Error("cloud unreachable during ack");
    },
  };
  const { port } = makePrinter();
  const agent = new PrintAgent(CFG, { cloud, printer: port, logger: QUIET });

  // Should resolve without throwing despite the ack error.
  const ok = await agent.processJob(JOB);
  assert.equal(ok, true);
});

test("runOnce processes every job returned by a poll", async () => {
  const jobs: PrintJob[] = [
    { ...JOB, id: "a" },
    { ...JOB, id: "b" },
    { ...JOB, id: "c" },
  ];
  const acks: string[] = [];
  const cloud: CloudPort = {
    pollJobs: async () => jobs,
    ackJob: async (id) => acks.push(id),
  };
  const { port, sends } = makePrinter();
  const agent = new PrintAgent(CFG, { cloud, printer: port, logger: QUIET });

  const count = await agent.runOnce();

  assert.equal(count, 3);
  assert.equal(sends.length, 3);
  assert.deepEqual(acks.sort(), ["a", "b", "c"]);
});

test("computeBackoff grows exponentially and is capped", () => {
  const cloud: CloudPort = { pollJobs: async () => [], ackJob: async () => {} };
  const { port } = makePrinter();
  const agent = new PrintAgent(CFG, {
    cloud,
    printer: port,
    logger: QUIET,
    baseBackoffMs: 1000,
    maxBackoffMs: 8000,
    random: () => 1, // full jitter -> returns the cap exactly
  });

  assert.equal(agent.computeBackoff(1), 1000);
  assert.equal(agent.computeBackoff(2), 2000);
  assert.equal(agent.computeBackoff(3), 4000);
  assert.equal(agent.computeBackoff(4), 8000);
  assert.equal(agent.computeBackoff(5), 8000); // capped
  assert.equal(agent.computeBackoff(99), 8000); // still capped
});

test("computeBackoff applies jitter (never exceeds the ceiling)", () => {
  const cloud: CloudPort = { pollJobs: async () => [], ackJob: async () => {} };
  const { port } = makePrinter();
  const agent = new PrintAgent(CFG, {
    cloud,
    printer: port,
    logger: QUIET,
    baseBackoffMs: 1000,
    maxBackoffMs: 8000,
    random: () => 0.5,
  });
  assert.equal(agent.computeBackoff(1), 500);
  assert.equal(agent.computeBackoff(3), 2000);
});

test("start() backs off on poll failure then recovers, and stops cleanly", async () => {
  let pollCalls = 0;
  const sleeps: number[] = [];
  const jobs: PrintJob[] = [{ ...JOB, id: "recovered" }];
  const acks: string[] = [];

  const cloud: CloudPort = {
    pollJobs: async () => {
      pollCalls += 1;
      if (pollCalls === 1) throw new Error("network down");
      return jobs;
    },
    ackJob: async (id) => acks.push(id),
  };
  const { port, sends } = makePrinter();
  const agent = new PrintAgent(CFG, {
    cloud,
    printer: port,
    logger: QUIET,
    baseBackoffMs: 1,
    maxBackoffMs: 4,
    random: () => 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  // First iteration fails (backoff), second succeeds and prints.
  await agent.start(2);

  assert.equal(pollCalls, 2);
  assert.equal(sends.length, 1);
  assert.deepEqual(acks, ["recovered"]);
  // First sleep is the backoff after the 1st failure: exp = base*2^0 = 1,
  // full jitter with random()=1 -> 1ms. The loop then reset the failure
  // count after the successful 2nd poll.
  assert.equal(sleeps[0], 1);
  assert.equal(agent.pollFailureCount, 0);
});

test("start() stops promptly when stop() is called", async () => {
  let pollCalls = 0;
  const cloud: CloudPort = {
    pollJobs: async () => {
      pollCalls += 1;
      return [];
    },
    ackJob: async () => {},
  };
  const { port } = makePrinter();
  const agent = new PrintAgent(CFG, {
    cloud,
    printer: port,
    logger: QUIET,
    sleep: async () => {
      agent.stop(); // stop during the inter-poll sleep
    },
  });

  await agent.start(50);
  assert.equal(pollCalls, 1);
});
