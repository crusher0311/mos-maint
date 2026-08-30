import type { Db } from "mongodb";
import { dualWritePgIdentity } from "@/lib/db/wave4-write-mode";
import {
  updateUserFields,
  deleteUserById,
  deleteSessionsByShopId as pgDeleteSessionsByShopId,
} from "@/lib/data/repositories/pg/identity";

export const __enterpriseAccessDeps = {
  dualWritePgIdentity,
  updateUserFields,
  deleteUserById,
  pgDeleteSessionsByShopId,
};

/**
 * Unified multi-location ("shop") access for enterprise users.
 *
 * Background: access used to be tracked two competing ways:
 *   - Model A: one `users` doc PER shop (same email/passwordHash duplicated).
 *   - Model B: a single `users` doc with a `shopIds` array.
 * The Postgres (Wave 4) identity model is built around Model B (a `shop_ids`
 * column), so the canonical direction is Model B.
 *
 * These helpers READ access as the UNION of both shapes (so existing duplicate
 * docs still resolve correctly with no migration) but WRITE access into the
 * `shopIds` array (Model B). Revoke also removes any leftover duplicate doc so
 * the union read can't keep reporting stale access. shopIds are stored as
 * STRINGS to match the User Settings writer (`/api/settings/users/[userId]`).
 */

export interface ShopAccessEntry {
  shopId: number;
  shopName: string;
  locationIdentifier: string | null;
  userId: string;
}

export interface EnterpriseUserRow {
  email: string;
  name: string | null;
  role: string;
  createdAt: unknown;
  shopAccess: ShopAccessEntry[];
}

export interface ShopInfo {
  name: string;
  locationIdentifier: string | null;
}

export interface AccessResult {
  ok: boolean;
  status?: number;
  error?: string;
  message?: string;
  matchedCount?: number;
  updatedCount?: number;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const ROLE_RANK: Record<string, number> = {
  owner: 5,
  admin: 4,
  manager: 3,
  user: 2,
  viewer: 1,
};

function higherRole(a: string | undefined, b: string | undefined): string {
  const ra = ROLE_RANK[a || ""] || 0;
  const rb = ROLE_RANK[b || ""] || 0;
  return rb > ra ? (b as string) : (a as string) || (b as string) || "user";
}

/** Build the match list so queries hit both number- and string-typed shopIds. */
function matchIdsFor(enterpriseShopIds: number[]): Array<number | string> {
  return [...enterpriseShopIds, ...enterpriseShopIds.map(String)];
}

/**
 * List every enterprise user with their accessible shops, computed as the
 * UNION of each doc's primary `shopId` and its `shopIds` array, restricted to
 * shops that belong to the enterprise.
 */
export async function loadEnterpriseUsers(
  db: Db,
  enterpriseShopIds: number[],
  shopMap: Map<number, ShopInfo>,
): Promise<EnterpriseUserRow[]> {
  const idNums = enterpriseShopIds.map(Number).filter((n) => Number.isFinite(n));
  const idSet = new Set(idNums);
  const matchIds = matchIdsFor(idNums);

  const users = await db
    .collection("users")
    .find({
      $or: [{ shopId: { $in: matchIds } }, { shopIds: { $in: matchIds } }],
    })
    .project({ _id: 1, email: 1, role: 1, shopId: 1, shopIds: 1, name: 1, createdAt: 1 })
    .toArray();

  const byEmail = new Map<
    string,
    {
      email: string;
      name: string | null;
      role: string;
      createdAt: unknown;
      shops: Map<number, string>;
    }
  >();

  for (const u of users) {
    const email = (u.email || "").toLowerCase();
    if (!email) continue;

    let entry = byEmail.get(email);
    if (!entry) {
      entry = {
        email,
        name: u.name || null,
        role: u.role || "user",
        createdAt: u.createdAt,
        shops: new Map<number, string>(),
      };
      byEmail.set(email, entry);
    } else {
      entry.role = higherRole(entry.role, u.role);
      if (!entry.name && u.name) entry.name = u.name;
    }

    const accessible = new Set<number>();
    const pn = toNum(u.shopId);
    if (pn !== null) accessible.add(pn);
    if (Array.isArray(u.shopIds)) {
      for (const s of u.shopIds) {
        const n = toNum(s);
        if (n !== null) accessible.add(n);
      }
    }
    for (const n of accessible) {
      if (idSet.has(n) && !entry.shops.has(n)) {
        entry.shops.set(n, u._id.toString());
      }
    }
  }

  return [...byEmail.values()]
    .map((e) => ({
      email: e.email,
      name: e.name,
      role: e.role,
      createdAt: e.createdAt,
      shopAccess: [...e.shops.entries()]
        .map(([shopId, userId]) => ({
          shopId,
          shopName: shopMap.get(shopId)?.name || `Shop ${shopId}`,
          locationIdentifier: shopMap.get(shopId)?.locationIdentifier ?? null,
          userId,
        }))
        .sort((a, b) => a.shopId - b.shopId),
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

async function loadUserDocs(db: Db, emailLower: string, enterpriseShopIds: number[]) {
  const matchIds = matchIdsFor(enterpriseShopIds);
  const escapedEmail = emailLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return db
    .collection("users")
    .find({
      $and: [
        {
          $or: [
            { email: { $regex: `^${escapedEmail}$`, $options: "i" } },
            { emailLower },
          ],
        },
        { $or: [{ shopId: { $in: matchIds } }, { shopIds: { $in: matchIds } }] },
      ],
    })
    .toArray();
}

/**
 * Change an enterprise member's role without leaving duplicate per-location
 * documents out of sync. Authorization belongs in the calling route; this
 * helper only enforces safe target roles and enterprise-scoped documents.
 */
export async function updateEnterpriseUserRole(
  db: Db,
  opts: {
    enterpriseShopIds: number[];
    email: string;
    role: string;
    updatedBy: string;
  },
): Promise<AccessResult> {
  const emailLower = opts.email.trim().toLowerCase();
  const role = opts.role.trim().toLowerCase();

  if (!["admin", "user"].includes(role)) {
    return { ok: false, status: 400, error: "Role must be admin or user" };
  }

  const docs = await loadUserDocs(db, emailLower, opts.enterpriseShopIds);
  if (docs.length === 0) {
    return { ok: false, status: 404, error: "User not found in enterprise" };
  }
  if (docs.some((doc) => String(doc.role || "").toLowerCase() === "owner")) {
    return { ok: false, status: 400, error: "The enterprise owner role cannot be changed here" };
  }

  const docIds = docs.map((doc) => doc._id);
  const result = await db.collection("users").updateMany(
    { _id: { $in: docIds } },
    {
      $set: {
        role,
        emailLower,
        updatedAt: new Date(),
        updatedBy: opts.updatedBy,
      },
    },
  );

  for (const doc of docs) {
    await __enterpriseAccessDeps.dualWritePgIdentity(`users.update(enterprise role ${role})`, () =>
      __enterpriseAccessDeps.updateUserFields(String(doc._id), { role, emailLower }),
    );
  }

  return {
    ok: true,
    matchedCount: result.matchedCount ?? docs.length,
    updatedCount: result.modifiedCount ?? 0,
  };
}

function accessibleSet(docs: any[], enterpriseShopIds: number[]): Set<number> {
  const idSet = new Set(enterpriseShopIds);
  const acc = new Set<number>();
  for (const d of docs) {
    const pn = toNum(d.shopId);
    if (pn !== null && idSet.has(pn)) acc.add(pn);
    if (Array.isArray(d.shopIds)) {
      for (const s of d.shopIds) {
        const n = toNum(s);
        if (n !== null && idSet.has(n)) acc.add(n);
      }
    }
  }
  return acc;
}

/**
 * Grant a user access to a shop by writing the COMPLETE accessible shop list
 * into the `shopIds` array (Model B). To prevent the User Settings page (which
 * targets one specific doc by _id) and the Enterprise Overview (which unions
 * across docs) from disagreeing while duplicate docs still exist, the identical
 * list is written to EVERY one of the user's enterprise docs.
 */
export async function grantShopAccess(
  db: Db,
  opts: {
    enterpriseShopIds: number[];
    email: string;
    shopId: number;
    grantedBy: string;
  },
): Promise<AccessResult> {
  const emailLower = opts.email.toLowerCase();
  const targetNum = Number(opts.shopId);

  const docs = await loadUserDocs(db, emailLower, opts.enterpriseShopIds);
  if (docs.length === 0) {
    return { ok: false, status: 404, error: "User not found in enterprise" };
  }

  const acc = accessibleSet(docs, opts.enterpriseShopIds);
  if (acc.has(targetNum)) {
    return { ok: false, status: 400, error: "User already has access to this shop" };
  }

  acc.add(targetNum);
  const newShopIds = [...acc].sort((a, b) => a - b).map(String);
  const docIds = docs.map((d) => d._id);

  await db.collection("users").updateMany(
    { _id: { $in: docIds } },
    {
      $set: {
        shopIds: newShopIds,
        emailLower,
        updatedAt: new Date(),
        updatedBy: opts.grantedBy,
      },
    },
  );
  for (const d of docs) {
    await __enterpriseAccessDeps.dualWritePgIdentity(`users.update(grant shop ${targetNum})`, () =>
      __enterpriseAccessDeps.updateUserFields(String(d._id), { shopIds: newShopIds, emailLower }),
    );
  }

  return { ok: true };
}

/**
 * Revoke a user's access to a shop. Writes the COMPLETE remaining shop list to
 * every surviving doc, deletes any leftover duplicate per-shop doc whose
 * primary is the revoked shop, repoints a sole doc, and guarantees the user
 * keeps at least one location.
 */
export async function revokeShopAccess(
  db: Db,
  opts: {
    enterpriseShopIds: number[];
    email: string;
    shopId: number;
  },
): Promise<AccessResult> {
  const emailLower = opts.email.toLowerCase();
  const targetNum = Number(opts.shopId);

  const docs = await loadUserDocs(db, emailLower, opts.enterpriseShopIds);
  const acc = accessibleSet(docs, opts.enterpriseShopIds);

  if (!acc.has(targetNum)) {
    return { ok: false, status: 400, error: "User does not have access to this shop" };
  }
  if (acc.size <= 1) {
    return {
      ok: false,
      status: 400,
      error: "Cannot revoke - user must have at least one shop access",
    };
  }

  const remaining = [...acc].filter((n) => n !== targetNum).sort((a, b) => a - b);
  const remainingStr = remaining.map(String);

  // Plan keep vs delete UP FRONT so we never delete every doc. Docs whose
  // primary is NOT the revoked shop always survive. Docs whose primary IS the
  // revoked shop are deletable Model-A leftovers -- unless they are the only
  // docs, in which case one is kept and repointed to a remaining shop so login
  // survives (acc.size > 1 above guarantees `remaining` is non-empty).
  const targetPrimaryDocs = docs.filter((d) => toNum(d.shopId) === targetNum);
  const otherPrimaryDocs = docs.filter((d) => toNum(d.shopId) !== targetNum);

  const survivingIds: any[] = otherPrimaryDocs.map((d) => d._id);
  let docsToDelete = targetPrimaryDocs;
  let docToRepoint: (typeof docs)[number] | null = null;

  if (otherPrimaryDocs.length === 0 && targetPrimaryDocs.length > 0) {
    docToRepoint = targetPrimaryDocs[0];
    docsToDelete = targetPrimaryDocs.slice(1);
    survivingIds.push(docToRepoint._id);
  }

  for (const d of docsToDelete) {
    await db.collection("users").deleteOne({ _id: d._id });
    await __enterpriseAccessDeps.dualWritePgIdentity(`users.delete(revoke shop ${targetNum})`, () =>
      __enterpriseAccessDeps.deleteUserById(String(d._id)),
    );
  }

  if (docToRepoint) {
    await db.collection("users").updateOne(
      { _id: docToRepoint._id },
      { $set: { shopId: remaining[0], shopIds: remainingStr, updatedAt: new Date() } },
    );
    await __enterpriseAccessDeps.dualWritePgIdentity(`users.update(repoint shop ${targetNum})`, () =>
      __enterpriseAccessDeps.updateUserFields(String(docToRepoint._id), {
        shopId: remaining[0],
        shopIds: remainingStr,
      }),
    );
  }

  // Write the identical remaining list to every surviving doc.
  if (survivingIds.length > 0) {
    await db.collection("users").updateMany(
      { _id: { $in: survivingIds } },
      { $set: { shopIds: remainingStr, emailLower, updatedAt: new Date() } },
    );
    for (const id of survivingIds) {
      await __enterpriseAccessDeps.dualWritePgIdentity(`users.update(revoke shop ${targetNum})`, () =>
        __enterpriseAccessDeps.updateUserFields(String(id), { shopIds: remainingStr, emailLower }),
      );
    }
  }

  // Tear down sessions bound to the revoked shop (parity with prior behavior).
  await db.collection("sessions").deleteMany({ shopId: targetNum });
  await __enterpriseAccessDeps.dualWritePgIdentity("sessions.delete(enterprise revoke)", () =>
    __enterpriseAccessDeps.pgDeleteSessionsByShopId(targetNum),
  );

  return { ok: true };
}
