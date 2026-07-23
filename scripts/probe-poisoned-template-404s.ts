/**
 * Task #921 — sweep stale wrong-endpoint 404 rows out of
 * `protractor_template_cache`.
 *
 * The 2026-07-22 sync left ~3,024 `protractor_template_<id>` cache docs
 * for shop 219 with `is404: true` — artifacts of calling
 * /ServicePackageTemplate/Read/{id} with IDs that endpoint can never
 * serve. They expire on their own (6h TTL for 404s) but similar
 * poisoned rows may exist for other v1.0/template-fallback shops
 * fleet-wide, and the task #405 one-shot cleanup
 * (`task_405_clear_poisoned_template_404s`) already completed so it
 * won't re-fire. This is the re-runnable version.
 *
 * Default mode is READ-ONLY (safe to run any time — dev Mongo IS prod):
 * it reports per-shop is404 counts, split by cacheKey prefix
 * (`protractor_template_` legacy fallback vs `protractor_template_get_`
 * direct-get), plus oldest/newest fetchedAt so you can tell fresh
 * poisoning from rows about to TTL out.
 *
 * With `--fix` it deletes ONLY rows matching
 * `{ is404: true, cacheKey: /^protractor_template_/ }` — never
 * legitimate cached templates (those have is404 unset/false) and never
 * canned-job detail rows (`protractor_cannedjob_` prefix). Deletes are
 * an operator action; run report-only first.
 *
 * Usage:
 *   npx tsx scripts/probe-poisoned-template-404s.ts             # report only
 *   npx tsx scripts/probe-poisoned-template-404s.ts --fix       # delete all is404 template rows
 *   npx tsx scripts/probe-poisoned-template-404s.ts --fix 219   # delete only for these shopIds
 */
import { getDb } from "@/lib/mongo";

const PREFIX_REGEX = /^protractor_template_/;

async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const onlyShopIds = args
    .filter((a) => a !== "--fix")
    .map((a) => Number(a))
    .filter((n) => Number.isFinite(n) && n > 0);

  const db = await getDb();
  const cache = db.collection("protractor_template_cache");

  const match: Record<string, unknown> = {
    is404: true,
    cacheKey: PREFIX_REGEX,
  };
  if (onlyShopIds.length > 0) {
    match.shopId = { $in: onlyShopIds };
  }

  const rows = await cache
    .aggregate<{
      _id: { shopId: number; kind: string };
      count: number;
      oldest: Date | null;
      newest: Date | null;
    }>([
      { $match: match },
      {
        $group: {
          _id: {
            shopId: "$shopId",
            kind: {
              $cond: [
                {
                  $regexMatch: {
                    input: { $ifNull: ["$cacheKey", ""] },
                    regex: /^protractor_template_get_/,
                  },
                },
                "template_get",
                "template_fallback",
              ],
            },
          },
          count: { $sum: 1 },
          oldest: { $min: "$fetchedAt" },
          newest: { $max: "$fetchedAt" },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray();

  const total = rows.reduce((s, r) => s + r.count, 0);
  const shopIds = new Set(rows.map((r) => r._id.shopId));

  console.log(
    `[template-404-sweep] Found ${total} is404 template-cache rows across ` +
      `${shopIds.size} shops${onlyShopIds.length ? ` (filtered to shopIds ${onlyShopIds.join(", ")})` : ""}.`,
  );
  for (const r of rows) {
    const fmt = (d: Date | null) => (d ? new Date(d).toISOString() : "n/a");
    console.log(
      `  shop=${r._id.shopId} kind=${r._id.kind} count=${r.count} ` +
        `oldest=${fmt(r.oldest)} newest=${fmt(r.newest)}`,
    );
  }

  if (!fix) {
    console.log(
      `[template-404-sweep] Report-only mode; nothing deleted. ` +
        `Re-run with --fix to delete these rows (operator action — dev Mongo IS prod).`,
    );
    return;
  }

  if (total === 0) {
    console.log(`[template-404-sweep] --fix requested but nothing to delete.`);
    return;
  }

  const result = await cache.deleteMany(match);
  console.log(
    `[template-404-sweep] Deleted ${result.deletedCount} is404 template-cache rows ` +
      `across ${shopIds.size} shops. Legitimate cached templates (is404 unset/false) untouched.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[template-404-sweep] Failed: ${err?.message || err}`);
    process.exit(1);
  });
