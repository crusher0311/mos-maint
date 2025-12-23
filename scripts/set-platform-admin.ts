import { getDb } from "../lib/mongo";

async function setPlatformAdmin() {
  const email = process.argv[2];
  
  if (!email) {
    console.log("Usage: npx tsx scripts/set-platform-admin.ts <email>");
    console.log("Example: npx tsx scripts/set-platform-admin.ts admin@mosmaintenance.com");
    process.exit(1);
  }
  
  const db = await getDb();
  
  const user = await db.collection("users").findOne({ email });
  
  if (!user) {
    console.log(`User with email "${email}" not found.`);
    process.exit(1);
  }
  
  await db.collection("users").updateOne(
    { email },
    { $set: { isPlatformAdmin: true } }
  );
  
  console.log(`Successfully set ${email} as a platform admin.`);
  console.log("They can now access /platform-admin");
  
  process.exit(0);
}

setPlatformAdmin().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
