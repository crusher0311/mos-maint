import {
  activateProtractorOperatorStop,
  getProtractorOperatorStop,
} from "../lib/data/repositories/api-usage";
import { logAdminAction } from "../lib/audit-log";

const PRODUCTION_SERVICE_ID = "srv-d55jaqkhg0os73a5dd8g";

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (process.env.RENDER_SERVICE_ID !== PRODUCTION_SERVICE_ID) {
    throw new Error(`Refusing operator-stop access outside production service ${PRODUCTION_SERVICE_ID}`);
  }
  if (action === "status") {
    console.log(JSON.stringify(await getProtractorOperatorStop(), null, 2));
    return;
  }
  if (action !== "activate") {
    throw new Error("Usage: tsx scripts/protractor-operator-stop.ts status|activate <reason>");
  }
  const reason = rest.join(" ").trim();
  if (!reason) throw new Error("Activation reason is required");
  const changedBy = process.env.RENDER_INSTANCE_ID
    ? `render-one-off:${process.env.RENDER_INSTANCE_ID}`
    : `render-one-off:${PRODUCTION_SERVICE_ID}`;
  const state = await activateProtractorOperatorStop({
    changedBy,
    reason,
  });
  await logAdminAction({
    action: "protractor_operator_stop_activated",
    adminEmail: changedBy,
    details: { reason, via: "production_one_off" },
  });
  console.log(JSON.stringify(state, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});