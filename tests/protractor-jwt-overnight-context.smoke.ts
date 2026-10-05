import assert from "node:assert/strict";
import {
  runWithJwtOvernightTransport as run, getJwtOvernightContext as current,
  jwtOvernightDispatchError as dispatchError, jwtOvernightContextError as contextError,
} from "../lib/integrations/protractor/jwt-overnight-context";
import {
  compileJwtOvernightInvoiceRequest, type JwtOvernightGrant, type JwtOvernightRequest,
} from "../lib/protractor-jwt-overnight-policy";
const grant: JwtOvernightGrant = {
  version: 1, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canaryGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  manifestHash: "c".repeat(64), notBefore: new Date("2026-10-06T03:00:00Z"),
  expiresAt: new Date("2026-10-06T10:00:00Z"),
  windowKeys: ["233:2026-09-01", "234:2026-09-01"],
  maxRequests: 6, consumedRequests: 0, stopped: false,
};
const request: JwtOvernightRequest = {runId: grant.runId, shopId: 233,
  day: "2026-09-01", operation: "invoice-day", method: "GET"};
async function main() {
  const original = Date.now;
  const base = Date.parse("2026-10-06T04:00:00Z");
  let clock = base;
  Date.now = () => clock;
  try {
    let captured: ReturnType<typeof current>;
    const outside = current();
    assert.equal(outside, undefined);
    await run(grant, request, async () => {
      captured = current();
      assert.equal(contextError(233), null);
      assert.ok(contextError(234));
      const d = compileJwtOvernightInvoiceRequest(request, 0);
      assert.equal(dispatchError(d.endpoint, d.method, d.shopId), null);
      assert.ok(dispatchError(d.endpoint, "POST", 233));
      assert.ok(dispatchError("/Contact/", "GET", 233));
      assert.equal(Object.isFrozen(captured), true);
      assert.equal(Object.isFrozen(captured!.request), true);
      request.shopId = 999;
      assert.equal(captured!.request.shopId, 233, "Caller cannot mutate a captured shop");
      request.shopId = 233;
      clock += 60_000;
      assert.ok(contextError(233));
    });
    assert.equal(captured!.active, false, "Detached continuations lose authority");
    assert.equal(current(), undefined);
    clock = base;
    await assert.rejects(run(grant, request, async () => {
      captured = current();
      throw new Error("Rejected work");
    }), /Rejected work/);
    assert.equal(captured!.active, false);
    await Promise.all([233, 234].map(shopId => run(grant, {...request, shopId}, async () => {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(current()!.request.shopId, shopId);
    })));
    await assert.rejects(run({...grant, stopped: true}, request, async () => {}));
    await assert.rejects(run(grant, {...request, shopId: 227}, async () => {}));
    clock = grant.expiresAt.getTime();
    await assert.rejects(run(grant, request, async () => {}));
    console.log("JWT overnight context: binding, isolation, expiry and detached-work rejection passed.");
  } finally {Date.now = original;}
}
main().catch(e => {console.error(e); process.exitCode = 1;});
