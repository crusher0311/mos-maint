import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { concernAssistantFailure } from "../lib/concern-assistant-failure";

test("provider errors never expose credential fragments or request content", () => {
  for (const status of [401,403,429,500,undefined]) {
    const result = concernAssistantFailure({
      status, message: "sk-FAKE-SENSITIVE-FRAGMENT", headers: { authorization: "private" },
      request: { customer: "private" }, code: "untrusted-private",
    });
    assert.equal(result.status,503);
    assert.match(result.body.error,/continue without AI/);
    assert.doesNotMatch(JSON.stringify(result),/SENSITIVE|private|untrusted/);
    assert.equal(result.diagnostic.category,status===401||status===403?"provider_auth":status===429?"provider_limit":"request_failed");
  }
  for (const error of [null,undefined,"secret",new Error("secret")]) {
    assert.doesNotMatch(JSON.stringify(concernAssistantFailure(error)),/secret/);
  }
});

test("both concern POST routes use the safe failure response", () => {
  for (const path of ["app/api/dashboard/concern-assistant/route.ts","app/api/extension/concern-assistant/route.ts"]) {
    const text=readFileSync(path,"utf8");
    const lastCatch=text.slice(text.lastIndexOf("} catch (error: any)"));
    assert.match(lastCatch,/concernAssistantFailure\(error\)/);
    assert.doesNotMatch(lastCatch,/error\.message|error:", error/);
  }
});
