import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createRecoverySession } from "./JwtBulkRecoveryClient";

const payload = (status = "running", processed = 0) => ({
  ok: true, status, total: 235, processed,
  outcomes: [{ wo: "WO-1837", state: "held", reason: "Conflicting invoice evidence" }],
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});
const flush = async () => {
  await setImmediate();
  await setImmediate();
};

function harness(initial = response(payload("idle"))) {
  const requests: RequestInit[] = [];
  const timers = new Map<number, () => void>();
  const errors: (string | null)[] = [];
  const statuses: unknown[] = [];
  let timerId = 0;
  let handler: (init: RequestInit) => Promise<Response> = async () => initial.clone();
  const client = createRecoverySession({
    fetcher: (async (url: unknown, init: RequestInit) => {
      assert.equal(url, "/api/platform-admin/jwt-september-recovery");
      assert.equal(init.credentials, "include");
      requests.push(init);
      return handler(init);
    }) as typeof fetch,
    schedule: (callback, delay) => {
      assert.equal(delay, 1000);
      const id = ++timerId;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: id => { timers.delete(id as unknown as number); },
    onStatus: status => statuses.push(status),
    onError: error => errors.push(error),
    onActivity: () => {},
  });
  return {
    client, requests, timers, errors, statuses,
    setHandler(next: typeof handler) { handler = next; },
    async tick() {
      const entry = timers.entries().next().value;
      assert.ok(entry, "Expected a scheduled piece");
      timers.delete(entry[0]);
      entry[1]();
      await flush();
    },
    actions() { return requests.filter(r => r.method === "POST").map(r => JSON.parse(String(r.body)).action); },
  };
}

async function main() {
  // Even a saved "running" job only receives GET until an explicit run.
  const saved = harness(response(payload()));
  await saved.client.refresh();
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.requests[0].method, "GET");
  assert.equal(saved.timers.size, 0);
  saved.client.dispose();

  // Collection can advance independently of processed repair outcomes.
  const collecting = harness(response({
    ...payload(), phase: "collect", sourceScanned: 168,
  }));
  await collecting.client.refresh();
  assert.equal(collecting.timers.size, 0);
  assert.deepEqual(collecting.statuses[0], {
    ...payload(), phase: "collect", sourceScanned: 168,
  });
  collecting.setHandler(async () => response({
    ...payload(), phase: "collect", sourceScanned: 214,
  }));
  await collecting.client.run();
  assert.equal(collecting.timers.size, 1);
  assert.equal((collecting.statuses.at(-1) as { sourceScanned: number }).sourceScanned, 214);
  collecting.client.dispose();

  const h = harness();
  await h.client.refresh();
  let finishStart!: (value: Response) => void;
  h.setHandler(() => new Promise(resolve => { finishStart = resolve; }));
  const start = h.client.run();
  h.client.run();
  h.client.refresh();
  assert.deepEqual(h.actions(), ["start"]);
  assert.deepEqual(JSON.parse(String(h.requests[1].body)), { action: "start" });
  finishStart(response(payload()));
  await start;
  assert.equal(h.timers.size, 1);

  let finishStep!: (value: Response) => void;
  h.setHandler(init => JSON.parse(String(init.body)).action === "step"
    ? new Promise(resolve => { finishStep = resolve; })
    : Promise.resolve(response(payload("paused", 1))));
  await h.tick();
  h.client.run();
  h.client.pause();
  h.client.pause();
  assert.deepEqual(h.actions(), ["start", "step"], "Pause must wait for the in-flight piece");
  assert.equal(h.requests[2].signal, undefined, "Do not abort database transaction");
  finishStep(response(payload("running", 1)));
  await flush();
  assert.deepEqual(h.actions(), ["start", "step", "pause"]);
  assert.equal(h.timers.size, 0);
  assert.ok(JSON.stringify(h.statuses).includes("Conflicting invoice evidence"));

  h.setHandler(init => Promise.resolve(response(payload(
    JSON.parse(String(init.body)).action === "start" ? "running" : "complete", 235,
  ))));
  await h.client.run();
  await h.tick();
  assert.equal(h.timers.size, 0, "Complete stops the loop");
  const count = h.requests.length;
  h.client.run();
  assert.equal(h.requests.length, count);
  h.client.dispose();

  for (const failure of [
    () => Promise.resolve(response({}, 401)),
    () => Promise.resolve(response({}, 403)),
    () => Promise.resolve(response({}, 409)),
    () => Promise.resolve(response({}, 500)),
    () => Promise.resolve(response({ ok: true })),
    () => Promise.resolve(response({ ...payload(), phase: "unexpected" })),
    () => Promise.resolve(response({ ...payload(), phase: "collect", sourceScanned: -1 })),
    () => Promise.resolve(response({ ...payload(), error: "Backend failure" })),
    () => Promise.reject(new Error("Offline")),
  ]) {
    const failed = harness();
    await failed.client.refresh();
    failed.setHandler(failure);
    await failed.client.run();
    assert.equal(failed.timers.size, 0);
    assert.ok(failed.errors.at(-1));
    assert.deepEqual(failed.actions(), ["start"], "Failures must not retry writes");
    failed.client.dispose();
  }

  const closed = harness();
  await closed.client.refresh();
  closed.setHandler(async () => response(payload()));
  await closed.client.run();
  closed.client.dispose();
  assert.equal(closed.timers.size, 0);
  assert.deepEqual(closed.actions(), ["start"], "Unmount must not issue unload writes");

  const inFlight = harness();
  await inFlight.client.refresh();
  let finish!: (value: Response) => void;
  inFlight.setHandler(() => new Promise(resolve => { finish = resolve; }));
  const pending = inFlight.client.run();
  inFlight.client.dispose();
  const statusCount = inFlight.statuses.length;
  finish(response(payload()));
  await pending;
  assert.equal(inFlight.statuses.length, statusCount);
  assert.equal(inFlight.timers.size, 0);
  console.log("JWT bulk recovery client session tests passed");
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
