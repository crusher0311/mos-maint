/**
 * Smoke test for the in-process cron scheduler's HTTP transport
 * (`requestWithAbort` in `lib/cron/scheduler.cjs`).
 *
 * Regression target: the scheduler used to invoke cron routes via the global
 * `fetch()` (undici). undici applies a default `headersTimeout` of 300s — a
 * route that emits response headers only AFTER all work completes (e.g.
 * `protractor-sync`, configured with a 25-min `timeoutMs`) was aborted by
 * undici at ~300s with a generic "fetch failed", BEFORE the per-job
 * AbortController could fire. The job therefore NEVER landed a 200 and
 * `lastSuccessByJob` never advanced, silently staling every Protractor shop's
 * dashboard.
 *
 * `requestWithAbort` uses Node's `http`/`https` modules, which have no hidden
 * header timeout, so the per-job `timeoutMs` AbortController is the single
 * authoritative deadline.
 *
 * This locks in:
 *   1. A route that delays its response headers well past undici's 300s default
 *      (simulated with a short delay here) STILL resolves successfully — proving
 *      no hidden header-timeout governs the call.
 *   2. The AbortController signal aborts the request and surfaces an error named
 *      `AbortError` (which `runJob` maps to outcome.error = "timeout").
 *   3. Non-2xx responses resolve with ok=false and the body is readable.
 */

import assert from "node:assert";
import http from "node:http";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requestWithAbort } = require("../lib/cron/scheduler.cjs");

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

async function main() {
  // 1. Header-late route resolves (no hidden header timeout).
  {
    const server = http.createServer((_req, res) => {
      // Delay HEADERS, not just body — the exact shape undici's headersTimeout
      // punishes. Kept short so the test is fast; the real default we are
      // bypassing is 300s.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("done");
      }, 300);
    });
    const port = await listen(server);
    const res = await requestWithAbort(`http://127.0.0.1:${port}/`, {
      method: "GET",
      headers: { Authorization: "Bearer test" },
    });
    assert.strictEqual(res.ok, true, "header-late route should resolve ok");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.text(), "done");
    server.close();
  }

  // 2. AbortController signal aborts with name === "AbortError".
  {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("too-late");
      }, 2000);
    });
    const port = await listen(server);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    let caught: any = null;
    try {
      await requestWithAbort(`http://127.0.0.1:${port}/`, {
        method: "GET",
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "aborted request should reject");
    assert.strictEqual(
      caught.name,
      "AbortError",
      "abort must surface AbortError so runJob records outcome.error = 'timeout'"
    );
    server.close();
  }

  // 3. Non-2xx resolves with ok=false and a readable body.
  {
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("nope");
    });
    const port = await listen(server);
    const res = await requestWithAbort(`http://127.0.0.1:${port}/`, {
      method: "GET",
    });
    assert.strictEqual(res.ok, false, "503 should be ok=false");
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.text(), "nope");
    server.close();
  }

  console.log("cron-scheduler-fetch-timeout.smoke: PASS");
}

main().catch((err) => {
  console.error("cron-scheduler-fetch-timeout.smoke: FAIL");
  console.error(err);
  process.exit(1);
});
