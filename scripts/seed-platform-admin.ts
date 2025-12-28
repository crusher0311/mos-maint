import { getDb } from "../lib/mongo";
import bcrypt from "bcryptjs";

async function seedPlatformAdmin() {
  const email = process.argv[2];
  const password = process.argv[3];
  
  if (!email || !password) {
    console.log("Usage: npx tsx scripts/seed-platform-admin.ts <email> <password>");
    process.exit(1);
  }
  
  try {
    const db = await getDb();
    
    const existing = await db.collection("platform_admins").findOne({ email });
    if (existing) {
      console.log("Platform admin already exists, updating password...");
    }
    
    const hashedPassword = await bcrypt.hash(password, 12);
    
    await db.collection("platform_admins").updateOne(
      { email },
      {
        $set: {
          email,
          password: hashedPassword,
          isPlatformAdmin: true,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        }
      },
      { upsert: true }
    );
    
    console.log("Platform admin user seeded successfully!");
    console.log(`Email: ${email}`);
    console.log("They can now access /admin-login");
  } catch (error) {
    console.error("Error seeding platform admin:", error);
  }
  
  process.exit(0);
}

seedPlatformAdmin();
