import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inspect } from "node:util";
import {
  redactAppFueledHookConsoleArguments,
  redactAppFueledHookLogText,
} from "@/lib/appfueled-hook-log-redaction";
import { normalizeCallerPath } from "@/lib/slow-query/caller-context";

const token = "appfueled-secret-token";
const url = `/api/webhooks/appfueled/${token}?source=partner&retry=1`;

// Next-style access line: keep the useful method/status text, not credential.
const accessLog = redactAppFueledHookLogText(`POST ${url} 200 in 12ms`);
assert.match(accessLog, /POST .* 200 in 12ms/);
assert.doesNotMatch(accessLog, new RegExp(token));
assert.doesNotMatch(accessLog, /\?source=/);

const encodedToken = encodeURIComponent(`${token}/encoded-part`);
const malformedPath =
  `/api/webhooks/appfueled/${encodedToken}/unexpected/trailing` +
  `?copiedCredential=${encodedToken}`;
const malformedLog = redactAppFueledHookLogText(`POST ${malformedPath} 404`);
assert.equal(
  malformedLog,
  "POST /api/webhooks/appfueled/[REDACTED] 404",
);
assert.doesNotMatch(malformedLog, new RegExp(token));
assert.doesNotMatch(malformedLog, /unexpected|copiedCredential|encoded-part/);

const error = new Error(`delivery failed for ${url}`);
error.stack = `Error: delivery failed\n    at POST (${url})`;
const structured = {
  nested: { requestUrl: url },
  query: { callback: `https://partner.example${url}` },
  error,
};
const rendered = inspect(redactAppFueledHookConsoleArguments([structured]), {
  depth: null,
});
assert.doesNotMatch(rendered, new RegExp(token));
assert.doesNotMatch(rendered, /\?source=/);
assert.match(rendered, /delivery failed/);

// Redaction is bounded and does not execute caller-controlled custom inspect.
let customInspectCalled = false;
const custom = {
  message: `safe context before ${url}`,
  [Symbol.for("nodejs.util.inspect.custom")]() {
    customInspectCalled = true;
    return `unsafe ${url}`;
  },
};
const customRendered = inspect(redactAppFueledHookConsoleArguments([custom]));
assert.equal(customInspectCalled, false);
assert.doesNotMatch(customRendered, new RegExp(token));
assert.match(customRendered, /safe context before/);

let deep: Record<string, unknown> = { url };
for (let i = 0; i < 20; i++) deep = { child: deep };
const boundedRendered = inspect(redactAppFueledHookConsoleArguments([deep]), {
  depth: null,
});
assert.match(boundedRendered, /bounded redaction/);
assert.doesNotMatch(boundedRendered, new RegExp(token));

// Caller tagging remains template-driven and therefore never records token data.
assert.equal(normalizeCallerPath(url), "/api/webhooks/appfueled/:token");

const preload = path.resolve("scripts/appfueled-log-preload.cjs");
const fixture = path.resolve("tests/fixtures/appfueled-log-preload-child.cjs");
const subprocess = spawnSync(
  process.execPath,
  ["--require", preload, fixture],
  { encoding: "utf8" },
);
assert.equal(subprocess.status, 0, subprocess.stderr);
const subprocessOutput = `${subprocess.stdout}${subprocess.stderr}`;
assert.doesNotMatch(subprocessOutput, /subprocess-appfueled-credential/);
assert.doesNotMatch(subprocessOutput, /source=regression|unexpected|copy=/);
assert.doesNotMatch(
  subprocessOutput,
  /MixedCaseCredential|OVERFLOW_TAIL_CREDENTIAL|UINT8_CREDENTIAL|OFFSET_CREDENTIAL|MIXED_CHUNK_CREDENTIAL|HEX_CREDENTIAL|BASE64_CREDENTIAL|UTF16_CREDENTIAL|LATIN1_CREDENTIAL/,
);
assert.equal(
  subprocessOutput.match(/POST \/api\/webhooks\/appfueled\/\[REDACTED\] 503/g)?.length,
  2,
);
assert.match(
  subprocessOutput,
  /POST \/api\/webhooks\/appfueled\/\[REDACTED\] 401/,
);
assert.match(
  subprocessOutput,
  /POST \/api\/webhooks\/appfueled\/\[REDACTED\] 413/,
);
for (const status of [418, 419, 420, 421, 422, 423, 424]) {
  assert.match(
    subprocessOutput,
    new RegExp(`POST /api/webhooks/appfueled/\\[REDACTED\\] ${status}`),
  );
}

console.log("appfueled hook redaction smoke tests passed");