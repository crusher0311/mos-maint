import { reviewHeldImports, validateReviewScope } from "../../lib/protractor-held-review";
import { heldReviewStore } from "./review-store";

async function main() {
  const [mode, campaignId, shop, days, ...extra] = process.argv.slice(2);
  if (mode !== "--read-only" || extra.length || !days)
    throw Error("Usage: review.ts --read-only CAMPAIGN SHOP YYYY-MM-DD[,YYYY-MM-DD]");
  const scope = { campaignId, shopId: Number(shop), days: days.split(",") };
  validateReviewScope(scope);
  // Database instrumentation otherwise persists slow-query records even for SELECTs.
  // Process-local only: do not change the application or campaign environment.
  process.env.SLOW_QUERY_TRACKING_DISABLED = "1";
  // Lazy connections after strict argument validation. No apply/provider/restart mode exists.
  const [{ getDb }, { getClient }] = await Promise.all([import("../../lib/mongo"), import("../../lib/db/drizzle")]);
  const preview = await reviewHeldImports(heldReviewStore(await getDb(), getClient()), scope);
  console.log(JSON.stringify(preview, null, 2));
}
const watchdog = setTimeout(() => { console.error("Review deadline exceeded; no complete preview"); process.exit(1); }, 125000);
main().then(() => { clearTimeout(watchdog); process.exit(0); }).catch(() => {
  clearTimeout(watchdog);
  console.error("Read-only review failed; no complete preview. Check scope, read access and query limits.");
  process.exit(1);
});
