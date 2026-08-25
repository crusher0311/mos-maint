import { getDb } from "@/lib/data/db";

/** Read the union-shaped user grants used by reporting scope authorization. */
export async function listReportingUserShopAssignments(email: string): Promise<unknown[]> {
  const db = await getDb();
  const emailLower = email.toLowerCase();
  return db.collection("users").find({
    $or: [{ email: emailLower }, { emailLower }],
  }).project({ shopId: 1, shopIds: 1 }).toArray();
}
