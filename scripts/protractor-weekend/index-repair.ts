import { readFileSync } from "node:fs";
import { applyIndexRepair, prepareIndexRepair, validateRepairApproval } from "../../lib/protractor-index-repair";
import { validateReviewScope } from "../../lib/protractor-held-review";
import { heldReviewStore } from "./review-store";
import { indexRepairStore } from "./index-repair-store";

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  let scope: any, invoiceId: string, manifest: any, approval: any, environment: string;
  if (mode === "--prepare" && args.length === 4) {
    scope = { campaignId: args[0], shopId: Number(args[1]), days: args[2].split(",") };
    invoiceId = args[3];
    validateReviewScope(scope);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(invoiceId)) throw Error("Invalid invoice");
  } else if (mode === "--apply-approved" && args.length === 3) {
    for (const path of args.slice(0, 2)) if (readFileSync(path).length > 128000) throw Error("Input cap");
    manifest = JSON.parse(readFileSync(args[0], "utf8"));
    approval = JSON.parse(readFileSync(args[1], "utf8"));
    environment = args[2];
    validateRepairApproval(manifest, approval, environment);
  } else throw Error("Invalid arguments");
  process.env.SLOW_QUERY_TRACKING_DISABLED = "1";
  const [{ getDb, getMongoClient }, { getClient }] = await Promise.all([
    import("../../lib/mongo"), import("../../lib/db/drizzle"),
  ]);
  const db = await getDb(), pg = getClient();
  if (mode === "--prepare") {
    console.log(JSON.stringify(await prepareIndexRepair(heldReviewStore(db, pg), scope, invoiceId!), null, 2));
  } else {
    console.log(JSON.stringify(await applyIndexRepair(indexRepairStore(db, await getMongoClient(), pg),
      manifest, approval, environment!)));
  }
}
const watchdog = setTimeout(() => {
  console.error("Repair deadline exceeded; outcome may be unknown. Reconcile, do not replay ingestion.");
  process.exit(1);
}, 125000);
main().then(() => { clearTimeout(watchdog); process.exit(0); }).catch(() => {
  clearTimeout(watchdog);
  console.error("Index repair held or unconfirmed. Check approval/evidence; reconcile before retry. No provider fallback.");
  process.exit(1);
});
