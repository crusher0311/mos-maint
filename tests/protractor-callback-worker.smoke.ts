import assert from "node:assert/strict";
import { assertCallbackWorkerConfiguration, callbackExecutionTarget } from "../lib/integrations/protractor/callback-worker-policy";
import { runCallbackWorkerLoop } from "../lib/integrations/protractor/callback-worker-loop";

async function main() {
  assert.equal(callbackExecutionTarget({}), "web");
  assert.throws(() => callbackExecutionTarget({ PROTRACTOR_CALLBACK_EXECUTION_TARGET: "typo" }));
  assert.throws(() => assertCallbackWorkerConfiguration({}));
  const enabled = {
    PROTRACTOR_CALLBACK_EXECUTION_TARGET: "worker",
    PROTRACTOR_CALLBACK_WORKER_ENABLED: "true",
    PROTRACTOR_RELAY_MODE: "relay",
    RENDER_INSTANCE_ID: "test-worker",
  };
  assert.doesNotThrow(() => assertCallbackWorkerConfiguration(enabled));
  assert.throws(() => assertCallbackWorkerConfiguration({ ...enabled, REPLIT_DEV_DOMAIN: "preview" }));
  assert.throws(() => assertCallbackWorkerConfiguration({ ...enabled, PROTRACTOR_RELAY_MODE: "direct" }));
  let stopped = false, calls = 0, active = 0, failures = 0, slept = 0;
  await runCallbackWorkerLoop({
    stopping: () => stopped,
    drain: async () => {
      assert.equal(active++, 0);
      calls++;
      await Promise.resolve();
      active--;
      if (calls === 1) throw new Error("transient");
      if (calls === 3) stopped = true;
      return { processed: calls === 2 ? 0 : 1, failed: 0 };
    },
    sleep: async ms => { slept += ms; },
    report: result => { if (!result) failures++; },
  });
  assert.equal(calls, 3);
  assert.equal(failures, 1);
  assert.equal(slept, 15_000);
  let idleCalls = 0;
  stopped = false;
  await runCallbackWorkerLoop({
    stopping: () => stopped,
    drain: async () => { idleCalls++; return { processed: 0, failed: 0 }; },
    sleep: async () => { stopped = true; },
    report: () => {},
  });
  assert.equal(idleCalls, 1);
  console.log("callback worker policy, serial execution, backoff and shutdown passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
