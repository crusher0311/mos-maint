import { getDb, getMongoClient } from "../lib/mongo";

async function main() {
  console.log("Connecting to MongoDB...");
  const db = await getDb();

  const usersWithoutEmailLower = await db.collection("users").find({
    emailLower: { $exists: false },
    email: { $exists: true },
  }).project({ _id: 1, email: 1, shopId: 1, role: 1 }).toArray();

  console.log(`Found ${usersWithoutEmailLower.length} users missing emailLower field`);

  let updated = 0;
  for (const user of usersWithoutEmailLower) {
    if (user.email) {
      const emailLower = user.email.toLowerCase().trim();
      await db.collection("users").updateOne(
        { _id: user._id },
        { $set: { emailLower } }
      );
      console.log(`  Updated: ${emailLower} (shopId: ${user.shopId}, role: ${user.role})`);
      updated++;
    }
  }

  console.log(`\nBackfilled emailLower on ${updated} users`);

  const totalUsers = await db.collection("users").countDocuments();
  const withEmailLower = await db.collection("users").countDocuments({ emailLower: { $exists: true } });
  console.log(`Total users: ${totalUsers}, with emailLower: ${withEmailLower}`);

  const client = await getMongoClient();
  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
