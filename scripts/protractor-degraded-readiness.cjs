// Deliberately do not load dotenv or bootstrap the application.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const env = { PATH: process.env.PATH, HOME: "/tmp", NODE_ENV: "test",
  PROTRACTOR_OFFLINE_ALLOW_LOOPBACK: "false" };
const suites = [
  "tests/protractor-degraded-readiness.smoke.ts",
  "tests/protractor-foreground-canned-cache.smoke.ts",
  "tests/wizard-create-priority.smoke.ts",
  "tests/extension-create-clientRequestId.smoke.ts",
  "tests/protractor-retry-limiter-deadlock.smoke.ts",
  "tests/browser/protractor-degraded.smoke.tsx",
];
let failures = 0;
for (const file of suites) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    "--require", "./tests/helpers/deny-network-egress.cjs",
    "--require", "./scripts/_stubs/server-only-stub.cjs",
    "--import", "tsx", file,
  ], { cwd: root, env: { ...env, PROTRACTOR_OFFLINE_ALLOW_LOOPBACK: file.includes("/browser/") ? "true" : "false" },
    encoding: "utf8", timeout: 90000, killSignal: "SIGKILL", maxBuffer: 8e6 });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  const outcome = result.error || result.signal ? "ENVIRONMENT_FAILURE" : result.status ? "ASSERTION_OR_RUNTIME_FAILURE" : "PASS";
  console.log(JSON.stringify({ file, outcome, exit: result.status, signal: result.signal, elapsedMs: Date.now() - started }));
  if (outcome !== "PASS") failures++;
}
process.exitCode = failures ? 1 : 0;
