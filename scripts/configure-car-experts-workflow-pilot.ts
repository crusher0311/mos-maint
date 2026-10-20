import {connectionHash, PILOT_SHOP} from "../lib/auto-dvi/pilot/model";
import {configureCarExpertsPilot, closePilotAdmin} from "../lib/data/repositories/workflow-dvi-pilot-admin";
import {resolveProtractorConfig} from "../lib/integrations/protractor";

// No implicit mutation. Activation requires an operator's separate serving-build
// attestation, not a claim that this task fork has been deployed.
const action = process.argv[2];
let opened = false;
async function main() {
  if (!["plan", "provision", "activate", "rollback"].includes(action)) throw Error("Explicit action required");
  if (action !== "plan" && !process.argv.includes("--operator-approved")) throw Error("Operator approval required");
  if (action === "activate" && !process.argv.includes("--serving-build-verified")) throw Error("Verify the merged serving build before activation");
  opened = true;
  const config = await resolveProtractorConfig(PILOT_SHOP);
  if (!config.configured || config.shopId !== PILOT_SHOP) throw Error("Exact shop connection required");
  console.log(JSON.stringify(await configureCarExpertsPilot(action as "plan" | "provision" | "activate" | "rollback",
    connectionHash(config.connectionId))));
}
main().catch(() => {
  console.error("Pilot command stopped. Inspect the authorized operator environment; do not repeat an uncertain mutation automatically.");
  process.exitCode = 1;
}).finally(async () => { if (opened) await closePilotAdmin(); });
