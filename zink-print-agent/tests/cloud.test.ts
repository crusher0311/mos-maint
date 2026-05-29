import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { CloudClient } from "../src/cloud";
import type { AckJobRequest } from "../src/contract";

interface MockState {
  pollAuth: string | null;
  pollPath: string | null;
  acks: Array<{ id: string; body: AckJobRequest; auth: string | null }>;
}

async function startMockCloud(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, state: MockState) => void,
): Promise<{ baseUrl: string; state: MockState; close: () => Promise<void> }> {
  const state: MockState = { pollAuth: null, pollPath: null, acks: [] };
  const server = http.createServer((req, res) => handler(req, res, state));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

test("pollJobs sends bearer auth + printerId and parses jobs[]", async () => {
  const mock = await startMockCloud((req, res, state) => {
    state.pollAuth = req.headers.authorization ?? null;
    state.pollPath = req.url ?? null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jobs: [{ id: "job1", imageBase64: "AQID" }],
      }),
    );
  });

  const client = new CloudClient({
    baseUrl: mock.baseUrl,
    apiKey: "secret-key",
    printerId: "front-counter",
  });
  const jobs = await client.pollJobs();

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "job1");
  assert.equal(mock.state.pollAuth, "Bearer secret-key");
  assert.ok(mock.state.pollPath?.includes("/api/print-agent/jobs"));
  assert.ok(mock.state.pollPath?.includes("printerId=front-counter"));

  await mock.close();
});

test("pollJobs returns [] for an empty queue", async () => {
  const mock = await startMockCloud((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jobs: [] }));
  });
  const client = new CloudClient({ baseUrl: mock.baseUrl, apiKey: "k" });
  const jobs = await client.pollJobs();
  assert.deepEqual(jobs, []);
  await mock.close();
});

test("pollJobs throws on non-2xx", async () => {
  const mock = await startMockCloud((_req, res) => {
    res.writeHead(503);
    res.end("nope");
  });
  const client = new CloudClient({ baseUrl: mock.baseUrl, apiKey: "k" });
  await assert.rejects(() => client.pollJobs(), /HTTP 503/);
  await mock.close();
});

test("pollJobs throws when jobs[] is missing", async () => {
  const mock = await startMockCloud((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ notJobs: true }));
  });
  const client = new CloudClient({ baseUrl: mock.baseUrl, apiKey: "k" });
  await assert.rejects(() => client.pollJobs(), /missing jobs/);
  await mock.close();
});

test("ackJob posts status + auth to the ack endpoint", async () => {
  const mock = await startMockCloud(async (req, res, state) => {
    if (req.method === "POST") {
      const raw = await readBody(req);
      const m = req.url?.match(/\/api\/print-agent\/jobs\/([^/]+)\/ack/);
      state.acks.push({
        id: m ? decodeURIComponent(m[1]) : "?",
        body: JSON.parse(raw),
        auth: req.headers.authorization ?? null,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const client = new CloudClient({ baseUrl: mock.baseUrl, apiKey: "abc" });
  const result = await client.ackJob("job 1", {
    status: "success",
    durationMs: 42,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(mock.state.acks.length, 1);
  assert.equal(mock.state.acks[0].id, "job 1");
  assert.equal(mock.state.acks[0].body.status, "success");
  assert.equal(mock.state.acks[0].body.durationMs, 42);
  assert.equal(mock.state.acks[0].auth, "Bearer abc");

  await mock.close();
});
