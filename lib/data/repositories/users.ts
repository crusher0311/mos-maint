// Repository for the `users` collection — only the operations the
// migrated callers actually need. Broader user CRUD still lives in
// `lib/auth.ts`; this is a deliberately narrow surface for callers
// like announcements / targeting.
import type { Collection, Filter, ObjectId as ObjectIdType } from "mongodb";
import { getDb } from "@/lib/data/db";
import { isIdentityPgCanonical } from "@/lib/db/wave4-write-mode";
import * as pg from "./pg/identity";

const COLLECTION = "users";

export interface UserDoc {
  _id?: ObjectIdType;
  email?: string;
  shopId?: number;
  role?: string;
  [extra: string]: unknown;
}

async function collection(): Promise<Collection<UserDoc>> {
  const db = await getDb();
  return db.collection<UserDoc>(COLLECTION);
}

export async function listUsers(
  query: Filter<UserDoc>,
  projection?: Record<string, 0 | 1>,
): Promise<UserDoc[]> {
  if (isIdentityPgCanonical()) {
    // Translate the exact Mongo filter shapes the migrated callers use
    // (lib/announcements.ts targeting + app/api/support/tickets shop
    // lookup) onto the typed PG predicate. Supported keys:
    //   - `email: { $exists: true }`  → no-op (email is NOT NULL in PG)
    //   - `email: <string>`           → emailLower equality
    //   - `shopId: { $in: [...] }`    → shopIdIn
    //   - `role:   { $in: [...] }`    → roleIn
    // Any other key/operator is a shape we don't support — surface it
    // loudly rather than silently returning the wrong rows.
    const predicate: {
      shopIdIn?: number[];
      roleIn?: string[];
      emailEquals?: string;
      emailExists?: boolean;
    } = {};
    for (const [k, v] of Object.entries(query)) {
      if (k === "email") {
        if (typeof v === "string") {
          predicate.emailEquals = v;
        } else if (
          v &&
          typeof v === "object" &&
          "$exists" in (v as Record<string, unknown>)
        ) {
          predicate.emailExists = Boolean((v as { $exists: unknown }).$exists);
        } else {
          throw new Error(
            `listUsers (PG canonical): unsupported email filter shape (see task 997)`,
          );
        }
      } else if (k === "shopId") {
        if (v && typeof v === "object" && Array.isArray((v as { $in?: unknown[] }).$in)) {
          predicate.shopIdIn = ((v as { $in: unknown[] }).$in).map((n) => Number(n));
        } else {
          throw new Error(
            `listUsers (PG canonical): unsupported shopId filter shape — only { $in: [...] } is translatable (see task 997)`,
          );
        }
      } else if (k === "role") {
        if (v && typeof v === "object" && Array.isArray((v as { $in?: unknown[] }).$in)) {
          predicate.roleIn = ((v as { $in: unknown[] }).$in).map((r) => String(r));
        } else {
          throw new Error(
            `listUsers (PG canonical): unsupported role filter shape — only { $in: [...] } is translatable (see task 997)`,
          );
        }
      } else {
        throw new Error(
          `listUsers (PG canonical): unsupported filter key "${k}" (see task 997)`,
        );
      }
    }
    // Projection is ignored on the PG side — returning full docs is a
    // safe superset; callers only read the fields they asked for.
    return (await pg.listUsersByPredicate(predicate)) as unknown as UserDoc[];
  }
  const col = await collection();
  const cursor = col.find(query);
  if (projection) cursor.project(projection);
  return cursor.toArray() as Promise<UserDoc[]>;
}

/**
 * Candidate source for the extension's provider-session identity match.
 *
 * Identity matching intentionally remains in the extension bootstrap domain
 * layer. This repository method only supplies a backend-neutral, read-only
 * user snapshot with credential material removed.
 */
export async function listExtensionBootstrapCandidateUsers(): Promise<UserDoc[]> {
  if (isIdentityPgCanonical()) {
    const rows = (await pg.listUsersByPredicate({})).filter(Boolean) as UserDoc[];
    return rows.map((row) => {
      const {
        password,
        passwordHash,
        extensionToken,
        ...safe
      } = row;
      void password;
      void passwordHash;
      void extensionToken;
      return safe;
    });
  }

  const col = await collection();
  return col
    .find({})
    .project({ password: 0, passwordHash: 0, extensionToken: 0 })
    .toArray() as Promise<UserDoc[]>;
}
