import { getDb as getMongoDb } from "../lib/mongo";
import { getDb as getSupabaseDb } from "../lib/db/drizzle";
import {
  crmParentOrganizations,
  crmAccounts,
  crmLocations,
} from "../lib/db/schema/crm-accounts";
import { eq } from "drizzle-orm";

interface MongoEnterprise {
  _id: any;
  name: string;
  shopIds: number[];
  createdAt?: Date;
  updatedAt?: Date;
}

interface MongoShop {
  _id: any;
  shopId: number;
  name: string;
  status?: string;
  contactEmail?: string;
  enterpriseId?: any;
  city?: string;
  state?: string;
  billing?: {
    plan?: string;
    status?: string;
  };
  createdAt?: Date;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function main() {
  console.log("=== MongoDB → CRM Migration ===\n");

  const mongo = await getMongoDb();
  const pg = getSupabaseDb();

  const enterprises = await mongo
    .collection<MongoEnterprise>("enterprise_accounts")
    .find({})
    .toArray();
  console.log(`Found ${enterprises.length} enterprise accounts in MongoDB`);

  const shops = await mongo
    .collection<MongoShop>("shops")
    .find({})
    .toArray();
  console.log(`Found ${shops.length} shops in MongoDB\n`);

  const existingAccounts = await pg.select().from(crmAccounts);
  const existingLinkedShopIds = new Set(
    existingAccounts.filter((a) => a.linkedShopId).map((a) => a.linkedShopId)
  );
  console.log(
    `${existingAccounts.length} CRM accounts already exist (${existingLinkedShopIds.size} linked to shops)\n`
  );

  const enterpriseIdToParentOrgId = new Map<string, string>();
  let parentOrgsCreated = 0;
  let parentOrgsSkipped = 0;

  for (const ent of enterprises) {
    const mongoId = ent._id.toString();

    const existing = await pg
      .select()
      .from(crmParentOrganizations)
      .where(eq(crmParentOrganizations.name, ent.name))
      .limit(1);

    if (existing.length > 0) {
      enterpriseIdToParentOrgId.set(mongoId, existing[0].id);
      parentOrgsSkipped++;
      console.log(`  ⏭ Parent Org already exists: "${ent.name}" (${existing[0].id})`);
      continue;
    }

    const [parentOrg] = await pg
      .insert(crmParentOrganizations)
      .values({
        name: ent.name,
        status: "Active",
      })
      .returning();

    enterpriseIdToParentOrgId.set(mongoId, parentOrg.id);
    parentOrgsCreated++;
    console.log(
      `  ✓ Created Parent Org: "${ent.name}" (${parentOrg.id}) — ${ent.shopIds.length} shops`
    );
  }

  console.log(
    `\nParent Orgs: ${parentOrgsCreated} created, ${parentOrgsSkipped} already existed\n`
  );

  let accountsCreated = 0;
  let accountsSkipped = 0;
  let locationsCreated = 0;

  for (const shop of shops) {
    if (existingLinkedShopIds.has(shop.shopId)) {
      accountsSkipped++;
      console.log(`  ⏭ Shop ${shop.shopId} "${shop.name}" already linked`);
      continue;
    }

    const parentOrgId = shop.enterpriseId
      ? enterpriseIdToParentOrgId.get(shop.enterpriseId.toString()) || null
      : null;

    const plan = shop.billing?.plan || "Growth";
    const planMap: Record<string, string> = {
      trial: "Trial",
      demo: "Demo",
      pro: "Pro",
      professional: "Pro",
      enterprise: "Enterprise",
      growth: "Growth",
    };
    const mappedPlan = planMap[plan.toLowerCase()] || "Growth";

    const statusMap: Record<string, string> = {
      active: "Active",
      trial: "Active",
      inactive: "Inactive",
      suspended: "Suspended",
    };
    const mappedStatus =
      statusMap[(shop.status || "active").toLowerCase()] || "Active";

    const [account] = await pg
      .insert(crmAccounts)
      .values({
        name: shop.name,
        parentOrganizationId: parentOrgId,
        plan: mappedPlan,
        status: mappedStatus,
        ownerEmail: shop.contactEmail || null,
        linkedShopId: shop.shopId,
      })
      .returning();

    accountsCreated++;

    const [location] = await pg
      .insert(crmLocations)
      .values({
        accountId: account.id,
        parentOrganizationId: parentOrgId,
        name: shop.name,
        city: shop.city || null,
        state: shop.state || null,
        linkedShopId: shop.shopId,
      })
      .returning();

    locationsCreated++;

    console.log(
      `  ✓ Shop ${shop.shopId} "${shop.name}" → Account ${account.id}` +
        (parentOrgId ? ` (under Parent Org)` : ` (standalone)`) +
        ` + Location ${location.id}`
    );
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Parent Organizations: ${parentOrgsCreated} created, ${parentOrgsSkipped} skipped`);
  console.log(`Accounts: ${accountsCreated} created, ${accountsSkipped} skipped`);
  console.log(`Locations: ${locationsCreated} created`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
