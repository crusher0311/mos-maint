/** Operator-managed worker entry point. Never invoked by app startup or tests.
 * Explicit --shops is required; no fleet discovery or default enrollment. */
export {};
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--shops" || !/^[1-9]\d*(,[1-9]\d*){0,9}$/.test(args[1])) {
    throw Error("Usage: dvi-recording-worker.ts --shops <approved-shop-id[,approved-shop-id]>");
  }
  const shops = [...new Set(args[1].split(",").map(Number))];
  if (shops.some(id => !Number.isSafeInteger(id))) throw Error("Invalid approved shop identity");
  const {dispatchRecordingPass} = await import("../lib/auto-dvi/staff/recording-dispatch");
  let stopping = false;
  process.once("SIGTERM", () => {stopping = true;});
  process.once("SIGINT", () => {stopping = true;});
  while (!stopping) {
    try {
      const result = await dispatchRecordingPass(shops);
      console.log(JSON.stringify({event: "dvi_recording_pass", ...result}));
    } catch {console.error(JSON.stringify({event: "dvi_recording_pass_unavailable"}));}
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
void main().catch(() => {console.error("Recording worker did not start. Supply explicit approved shop IDs and verify worker setup."); process.exitCode = 1;});
