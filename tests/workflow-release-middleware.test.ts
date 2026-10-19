import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";
import { decodeLink } from "../lib/auto-dvi/release/links";

test("anonymous report page and POST API reach bearer validation without opening staff or adjacent paths", async () => {
  const previous = process.env.DEV_AUTO_LOGIN;
  process.env.DEV_AUTO_LOGIN = "false";
  try {
    for (const [path, method] of [
      ["/workflow-report", "GET"], ["/workflow-report", "HEAD"], ["/api/workflow-report", "POST"],
    ]) {
      const request = new NextRequest(`https://reports.example.invalid${path}`, {method});
      assert.equal(request.cookies.size, 0);
      const response = await middleware(request);
      assert.equal(response.headers.get("x-middleware-next"), "1", `${method} ${path}`);
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    for (const [path, method] of [
      ["/api/workflow-report", "GET"], ["/api/workflow-report", "DELETE"],
      ["/api/workflow-report/admin", "POST"], ["/api/workflow-reports", "POST"],
      ["/api/shop-dispatch/inspection/release", "GET"], ["/api/shop-dispatch/inspection/release", "POST"],
      ["/api/shop-dispatch/inspection/media", "GET"],
    ]) {
      const response = await middleware(new NextRequest(`https://reports.example.invalid${path}`, {method}));
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.headers.get("x-middleware-next"), null);
    }
    const adjacent = await middleware(new NextRequest("https://reports.example.invalid/workflow-report/private"));
    assert.equal(adjacent.status, 307);
    assert.ok(adjacent.headers.get("location")?.includes("/login"));
    // Reaching the handler is not authorization. Anonymous requests still need
    // the signed bearer; lifecycle/media authorization is covered by storage tests.
    assert.throws(() => decodeLink("", "synthetic-offline-secret-32-characters"));
    assert.throws(() => decodeLink("guessed.invalid", "synthetic-offline-secret-32-characters"));
  } finally {
    if (previous === undefined) delete process.env.DEV_AUTO_LOGIN;
    else process.env.DEV_AUTO_LOGIN = previous;
  }
});
