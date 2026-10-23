import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { deliver, signature } from "../lib/protractor-exports/transport";

// Exercise the real production sender without DNS or sockets. No injectable
// destination bypass is added to application code.
test("production transport requires exact ACK and refreshes retry signatures", async (t) => {
  let status = 202, acknowledgment: string | undefined = "synthetic-delivery";
  let now = 1_792_670_400_000;
  const attempts: Array<{ body: string; headers: Record<string, string>; options: any }> = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(dns, "resolve4", async () => ["8.8.8.8"]);
  t.mock.method(https, "request", (_url: URL, options: any, callback: any) => {
    const req = new EventEmitter() as any;
    req.destroy = () => req.emit("close");
    req.end = (body: string) => {
      attempts.push({ body, headers: options.headers, options });
      queueMicrotask(() => callback({
        statusCode: status, headers: { "x-mos-acknowledgment": acknowledgment },
        destroy: () => req.emit("close"),
      }));
    };
    return req;
  });
  syncBuiltinESMExports();
  const body = '{"deliveryId":"synthetic-delivery","records":[]}';
  const send = () => deliver("https://receiver.example/hook", "ephemeral-fixture", "synthetic-delivery", body);
  try {
    await send();
    acknowledgment = undefined;
    await assert.rejects(send(), /receiver_not_acknowledged/);
    acknowledgment = "wrong";
    await assert.rejects(send(), /receiver_not_acknowledged/);
    acknowledgment = "synthetic-delivery"; status = 302;
    await assert.rejects(send(), /receiver_not_acknowledged/);
    status = 429;
    await assert.rejects(send(), /receiver_rate_limited/);
    now += 1000; status = 200;
    await send();
    const first = attempts[0], last = attempts.at(-1)!;
    assert.equal(first.body, last.body);
    assert.equal(first.headers["x-mos-delivery-id"], last.headers["x-mos-delivery-id"]);
    assert.notEqual(first.headers["x-mos-timestamp"], last.headers["x-mos-timestamp"]);
    assert.notEqual(first.headers["x-mos-signature"], last.headers["x-mos-signature"]);
    for (const attempt of attempts) {
      assert.equal(attempt.headers["x-mos-signature"], `v1=${signature("ephemeral-fixture",
        attempt.headers["x-mos-timestamp"], "synthetic-delivery", body)}`);
      attempt.options.lookup("receiver.example", {}, (error: unknown, address: string) => {
        assert.equal(error, null); assert.equal(address, "8.8.8.8");
      });
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
