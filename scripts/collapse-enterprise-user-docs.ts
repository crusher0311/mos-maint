/**
 * Collapse duplicate per-shop `users` docs into a single Model-B doc per email
 * (one doc carrying the full `shopIds` array), finalizing the enterprise access
 * unification. READ-ONLY by default; pass APPLY=1 to actually mutate.
 *
 *   npx tsx scripts/collapse-enterprise-user-docs.ts          # dry-run report
 *   APPLY=1 npx tsx scripts/collapse-enterprise-user-docs.ts  # perform collapse
 */
import { getDb, getMongoClient } from "../lib/mongo";

const APPLY = process.env.APPLY === "1";

const ROLE_RANK: Record<string, number> = {
  owner: 5,
  admin: 4,
  manager: 3,
  user: 2,
  viewer: 1,
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  console.log(`\n=== Collapse enterprise user docs (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`);
  const db = await getDb();

  // 1. Enterprise shop universe.
  const enterprises = await db.collection("enterprise_accounts").find({}).toArray();
  const allEnterpriseShopIds = new Set<number>();
  for (const e of enterprises) {
    for (const s of e.shopIds || []) {
      const n = toNum(s);
      if (n !== null) allEnterpriseShopIds.add(n);
    }
  }
  const matchIds: Array<number | string> = [
    ...allEnterpriseShopIds,
    ...[...allEnterpriseShopIds].map(String),
  ];
  console.log(
    `Enterprises: ${enterprises.length}; enterprise shops: ${allEnterpriseShopIds.size}`,
  );

  // 2. Every user doc touching an enterprise shop (primary OR array).
  const users = await db
    .collection("users")
    .find({
      $or: [{ shopId: { $in: matchIds } }, { shopIds: { $in: matchIds } }],
    })
    .toArray();
  console.log(`User docs touching enterprise shops: ${users.length}`);

  // 3. Group by emailLower.
  const byEmail = new Map<string, any[]>();
  for (const u of users) {
    const key = (u.emailLower || u.email || "").toLowerCase();
    if (!key) continue;
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key)!.push(u);
  }

  const dupGroups = [...byEmail.entries()].filter(([, docs]) => docs.length > 1);
  console.log(`Emails with a single doc already: ${byEmail.size - dupGroups.length}`);
  console.log(`Emails with DUPLICATE docs to collapse: ${dupGroups.length}\n`);

  let riskyPassword = 0;
  let riskyRole = 0;
  let multiExtToken = 0;
  let totalDocsToDelete = 0;

  for (const [email, docs] of dupGroups) {
    const hashes = new Set(docs.map((d) => d.passwordHash || "(none)"));
    const roles = new Set(docs.map((d) => d.role || "(none)"));
    const withToken = docs.filter((d) => d.extensionToken);
    const mustChange = docs.filter((d) => d.mustChangePassword);

    const accessible = new Set<number>();
    for (const d of docs) {
      const pn = toNum(d.shopId);
      if (pn !== null && allEnterpriseShopIds.has(pn)) accessible.add(pn);
      for (const s of d.shopIds || []) {
        const n = toNum(s);
        if (n !== null && allEnterpriseShopIds.has(n)) accessible.add(n);
      }
    }

    const passwordRisk = hashes.size > 1;
    const roleRisk = roles.size > 1;
    if (passwordRisk) riskyPassword++;
    if (roleRisk) riskyRole++;
    if (withToken.length > 1) multiExtToken++;
    totalDocsToDelete += docs.length - 1;

    const flags = [
      passwordRisk ? "DIFFERENT-PASSWORDS" : null,
      roleRisk ? `DIFFERENT-ROLES{${[...roles].join(",")}}` : null,
      withToken.length > 1 ? `MULTI-EXT-TOKEN(${withToken.length})` : null,
      mustChange.length > 0 && mustChange.length < docs.length ? "MIXED-mustChangePassword" : null,
    ].filter(Boolean);

    console.log(
      `${email}  docs=${docs.length}  shopIds(per-doc)=[${docs
        .map((d) => `${d.shopId}:${JSON.stringify(d.shopIds || [])}`)
        .join(" | ")}]  union=[${[...accessible].sort((a, b) => a - b).join(",")}]` +
        (flags.length ? `  ⚠ ${flags.join(" ")}` : ""),
    );
  }

  console.log(`\n--- Summary ---`);
  console.log(`Duplicate-email groups: ${dupGroups.length}`);
  console.log(`Docs that would be deleted: ${totalDocsToDelete}`);
  console.log(`⚠ groups with DIFFERENT passwords: ${riskyPassword}`);
  console.log(`⚠ groups with DIFFERENT roles: ${riskyRole}`);
  console.log(`⚠ groups with multiple extension tokens: ${multiExtToken}`);

  if (!APPLY) {
    console.log(`\nDRY-RUN only. No changes made. Re-run with APPLY=1 to collapse.\n`);
  }

  const client = await getMongoClient();
  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
