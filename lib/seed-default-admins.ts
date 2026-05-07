import type { Db } from "mongodb";
import bcrypt from "bcryptjs";
import crypto from "crypto";

/**
 * Emails that should be automatically attached as admins to every newly-created shop.
 * All three are platform admins, so this is purely about explicit shop-level association
 * (so they show up in shop user lists, can be selected as RO assignees, etc).
 */
export const DEFAULT_ADMIN_EMAILS = [
  "brandoncrusha@gmail.com",
  "brandon@myoilsticker.com",
  "mason@myoilsticker.com",
];

/**
 * Add the default admin emails to a newly-created shop.
 *
 * For each email:
 *   - If a user record exists, $addToSet the new shopId into their shopIds array
 *     (no other fields touched, so we don't disturb their primary shop or role).
 *   - If no user record exists, create one as role=admin / isPlatformAdmin=true with
 *     a random unguessable passwordHash and mustChangePassword=true. They'll log in
 *     via password reset if needed.
 *
 * Idempotent. Errors per-email are logged but never thrown — shop creation must
 * never fail just because the seed step had trouble.
 */
export async function seedDefaultAdmins(db: Db, newShopId: number): Promise<void> {
  const now = new Date();
  for (const rawEmail of DEFAULT_ADMIN_EMAILS) {
    const email = rawEmail.toLowerCase().trim();
    try {
      const existing = await db.collection("users").findOne(
        { emailLower: email },
        { projection: { _id: 1, shopIds: 1 } }
      );

      if (existing) {
        await db.collection("users").updateOne(
          { _id: existing._id },
          {
            $addToSet: { shopIds: newShopId },
            $set: { updatedAt: now },
          }
        );
        console.log(
          `[seedDefaultAdmins] Added shop ${newShopId} to existing user ${email}`
        );
      } else {
        const randomSecret = crypto.randomBytes(48).toString("hex");
        const passwordHash = await bcrypt.hash(randomSecret, 12);
        await db.collection("users").insertOne({
          email,
          emailLower: email,
          name: email.split("@")[0],
          passwordHash,
          role: "admin",
          isPlatformAdmin: true,
          shopId: newShopId,
          shopIds: [newShopId],
          mustChangePassword: true,
          autoSeededAdmin: true,
          createdAt: now,
          updatedAt: now,
        });
        console.log(
          `[seedDefaultAdmins] Created new auto-seeded admin user ${email} for shop ${newShopId}`
        );
      }
    } catch (err) {
      console.error(
        `[seedDefaultAdmins] Failed to seed ${email} on shop ${newShopId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
