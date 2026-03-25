import { getDb as getMongoDb } from "../lib/mongo";
import { getDb as getSupabaseDb } from "../lib/db/drizzle";
import { crmUsers } from "../lib/db/schema/crm-users";
import { crmAccounts, crmLocations } from "../lib/db/schema/crm-accounts";
import {
  crmContacts,
  crmContactAccountAssignments,
  crmContactLocationAssignments,
} from "../lib/db/schema/crm-contacts";
import { eq } from "drizzle-orm";

interface MongoUser {
  _id: any;
  email: string;
  emailLower?: string;
  role?: string;
  shopId?: number;
  shopIds?: (string | number)[];
  isPlatformAdmin?: boolean;
  createdAt?: Date;
  lastLogin?: Date;
}

async function main() {
  console.log("=== MongoDB Users → CRM Migration ===\n");

  const mongo = await getMongoDb();
  const pg = getSupabaseDb();

  const users = await mongo
    .collection<MongoUser>("users")
    .find({})
    .toArray();
  console.log(`Found ${users.length} users in MongoDB\n`);

  const accounts = await pg.select().from(crmAccounts);
  const locations = await pg.select().from(crmLocations);

  const shopIdToAccount = new Map<number, (typeof accounts)[0]>();
  for (const acc of accounts) {
    if (acc.linkedShopId) shopIdToAccount.set(acc.linkedShopId, acc);
  }

  const shopIdToLocation = new Map<number, (typeof locations)[0]>();
  for (const loc of locations) {
    if (loc.linkedShopId) shopIdToLocation.set(loc.linkedShopId, loc);
  }

  const existingCrmUsers = await pg.select().from(crmUsers);
  const existingMongoIds = new Set(
    existingCrmUsers.filter((u) => u.mongoUserId).map((u) => u.mongoUserId)
  );

  console.log(
    `${accounts.length} CRM accounts, ${locations.length} CRM locations available for linking`
  );
  console.log(`${existingCrmUsers.length} CRM users already exist\n`);

  let usersCreated = 0;
  let usersSkipped = 0;
  let contactsCreated = 0;

  for (const user of users) {
    const mongoId = user._id.toString();

    if (existingMongoIds.has(mongoId)) {
      usersSkipped++;
      console.log(`  ⏭ User already migrated: ${user.email}`);
      continue;
    }

    const emailLower = (user.emailLower || user.email || "").toLowerCase();
    if (!emailLower) {
      usersSkipped++;
      console.log(`  ⏭ Skipping user with no email (${mongoId})`);
      continue;
    }

    const shopId = user.shopId ? Number(user.shopId) : null;
    const shopIds = (user.shopIds || []).map(Number).filter((n) => !isNaN(n));

    const account = shopId ? shopIdToAccount.get(shopId) || null : null;
    const location = shopId ? shopIdToLocation.get(shopId) || null : null;

    const [crmUser] = await pg
      .insert(crmUsers)
      .values({
        email: user.email,
        emailLower,
        role: user.role || "user",
        shopId,
        shopIds: shopIds.length > 0 ? shopIds : [],
        isPlatformAdmin: user.isPlatformAdmin || false,
        accountId: account?.id || null,
        locationId: location?.id || null,
        mongoUserId: mongoId,
        status: "Active",
        lastLogin: user.lastLogin || null,
      })
      .returning();

    usersCreated++;

    const emailParts = emailLower.split("@");
    const namePart = emailParts[0] || "";
    const namePieces = namePart.split(/[._-]/);
    const firstName =
      namePieces[0]?.charAt(0).toUpperCase() + (namePieces[0]?.slice(1) || "");
    const lastName = namePieces.length > 1
      ? namePieces[namePieces.length - 1]?.charAt(0).toUpperCase() +
        (namePieces[namePieces.length - 1]?.slice(1) || "")
      : "";

    const existingContact = await pg
      .select()
      .from(crmContacts)
      .where(eq(crmContacts.email, emailLower))
      .limit(1);

    let contactId: string;

    if (existingContact.length > 0) {
      contactId = existingContact[0].id;
      console.log(
        `  ✓ User "${user.email}" → CRM User ${crmUser.id} (linked existing contact ${contactId})`
      );
    } else {
      const [contact] = await pg
        .insert(crmContacts)
        .values({
          firstName,
          lastName: lastName || "(User)",
          email: emailLower,
          title: user.role || "user",
          status: "Active",
        })
        .returning();

      contactId = contact.id;
      contactsCreated++;

      if (account) {
        await pg.insert(crmContactAccountAssignments).values({
          contactId,
          accountId: account.id,
          isPrimary: user.role === "owner",
        });
      }

      if (location) {
        await pg.insert(crmContactLocationAssignments).values({
          contactId,
          locationId: location.id,
          isPrimary: user.role === "owner",
        });
      }

      console.log(
        `  ✓ User "${user.email}" → CRM User ${crmUser.id} + Contact ${contactId}` +
          (account ? ` (linked to account "${account.name}")` : " (no shop link)")
      );
    }

    await pg
      .update(crmUsers)
      .set({ contactId })
      .where(eq(crmUsers.id, crmUser.id));
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`CRM Users: ${usersCreated} created, ${usersSkipped} skipped`);
  console.log(`CRM Contacts: ${contactsCreated} created`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
