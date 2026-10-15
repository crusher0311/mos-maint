/** Deployment routing only. Never grants provider admission or bypasses shared policy. */
export function callbackExecutionTarget(env: Readonly<Record<string, string | undefined>>): "web" | "worker" {
  const target = env.PROTRACTOR_CALLBACK_EXECUTION_TARGET ?? "web";
  if (target !== "web" && target !== "worker") {
    throw new Error("Invalid Protractor callback execution target");
  }
  return target;
}

export function assertCallbackWorkerConfiguration(env: Readonly<Record<string, string | undefined>>): void {
  if (callbackExecutionTarget(env) !== "worker" ||
      env.PROTRACTOR_CALLBACK_WORKER_ENABLED !== "true" ||
      env.PROTRACTOR_RELAY_MODE !== "relay" ||
      !env.RENDER_INSTANCE_ID || env.REPLIT_DEV_DOMAIN) {
    throw new Error("Dedicated callback worker is not explicitly enabled in an approved relay runtime");
  }
}
