import { spawn } from "node:child_process";
// Never inherit production credentials, NODE_OPTIONS, dotenv hooks or app flags.
const child = spawn(process.execPath, [
  "--require", "./tests/helpers/export-worker-network-guard.cjs",
  "--import", "tsx", "--test", "tests/protractor-export-worker-real-redis.test.ts",
], {
  stdio: "inherit",
  env: { PATH: process.env.PATH, NODE_ENV: "test" },
});
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
