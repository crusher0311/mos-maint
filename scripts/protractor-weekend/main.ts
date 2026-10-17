import { prepare } from "./prepare";
import { run } from "./run";
import { ingestPage } from "./ingest";
import { log } from "./shared";

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--inventory") return prepare(false);
  if (mode === "--prepare-approved") return prepare(true);
  if (mode === "--run-approved") return run();
  if (mode === "--ingest" && args.length === 2) return ingestPage(args[0], args[1]);
  throw Error("Explicit campaign mode required");
}
main().then(() => process.exit(0)).catch(() => {
  // Detailed evidence stays in persisted checkpoints, never customer payload logs.
  log("weekend_stopped"); process.exit(1);
});
