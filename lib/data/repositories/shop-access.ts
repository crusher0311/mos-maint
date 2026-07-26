// Repository helper: does an authenticated user have access to a given shop?
//
// Access = the session's own shop, any shop in the user's `shopIds` union
// (Model B enterprise access — see lib/enterprise-access.ts), or any shop in
// the same enterprise as the user's home shop. Platform-admin short-circuits
// are the CALLER's responsibility (they don't need a DB read).
import { getDb } from "@/lib/data/db";

export async function userHasShopAccess(
  email: string | null | undefined,
  sessionShopId: number,
  targetShopId: number,
): Promise<boolean> {
  if (Number(sessionShopId) === Number(targetShopId)) return true;

  const db = await getDb();

  // Model B union: users docs may carry a shopIds array (numbers or strings).
  if (email) {
    const userDocs = await db
      .collection("users")
      .find({ email })
      .project({ shopId: 1, shopIds: 1 })
      .toArray();
    for (const u of userDocs) {
      if (Number(u.shopId) === targetShopId) return true;
      if (
        Array.isArray(u.shopIds) &&
        u.shopIds.some((s: unknown) => Number(s) === targetShopId)
      ) {
        return true;
      }
    }
  }

  // Enterprise: target shop shares the enterpriseId of the user's home shop.
  const userShop = await db.collection("shops").findOne(
    { shopId: { $in: [sessionShopId, String(sessionShopId)] as any[] } },
    { projection: { enterpriseId: 1 } },
  );
  if (userShop?.enterpriseId) {
    const target = await db.collection("shops").findOne(
      {
        shopId: { $in: [targetShopId, String(targetShopId)] as any[] },
        enterpriseId: userShop.enterpriseId,
      },
      { projection: { _id: 1 } },
    );
    if (target) return true;
  }
  return false;
}
