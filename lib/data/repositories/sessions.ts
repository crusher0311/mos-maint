// Repository for the `sessions` collection.
//
// `lib/auth.ts` still owns the heavyweight session creation/cleanup
// flow; this is a deliberately narrow surface for callers that just
// need to look up or mutate a single row by token. The `lib/auth.ts`
// migration is tracked separately because that file mixes sessions,
// users, password-reset tokens, and rate-limit state.
import type { Collection, Filter, UpdateFilter } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isIdentityPgCanonical,
  shadowWriteMongoIdentity,
} from "@/lib/db/wave4-write-mode";
import * as pg from "./pg/identity";

const COLLECTION = "sessions";

export interface SessionDoc {
  token: string;
  shopId?: number | string;
  isImpersonation?: boolean;
  expiresAt?: Date;
  [extra: string]: unknown;
}

async function collection(): Promise<Collection<SessionDoc>> {
  const db = await getDb();
  return db.collection<SessionDoc>(COLLECTION);
}

/**
 * Look up an unexpired session by token. A row whose `expiresAt` is
 * not strictly greater than `now` is treated as missing so callers
 * don't accidentally trust a stale session.
 */
export async function findActiveSessionByToken(
  token: string,
): Promise<SessionDoc | null> {
  if (isIdentityPgCanonical()) {
    // PG repo returns a Mongo-shaped session doc (verbatim column
    // values: token/shopId/isImpersonation/expiresAt/…) so callers see
    // no shape change.
    return (await pg.findActiveSessionByToken(token)) as SessionDoc | null;
  }
  const col = await collection();
  return col.findOne({ token, expiresAt: { $gt: new Date() } });
}

/**
 * Update the session row with the given token. Returns the raw
 * matched/modified counts so callers that report on it (e.g. the
 * dev-only fix-session route) can keep their existing response shape.
 */
export async function updateSessionByToken(
  token: string,
  update: UpdateFilter<SessionDoc>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  if (isIdentityPgCanonical()) {
    // Callers only ever issue a plain `$set` here (the dev fix-session
    // route: `{ $set: { shopId } }`). Translate that `$set` map onto the
    // typed session columns the PG repo understands. Any non-`$set`
    // operator would be a shape we don't support — surface it loudly
    // rather than silently drop the write.
    const set = (update as { $set?: Record<string, unknown> }).$set ?? {};
    const otherOps = Object.keys(update).filter((k) => k !== "$set");
    if (otherOps.length > 0) {
      throw new Error(
        `updateSessionByToken (PG canonical): unsupported update operator(s) ${otherOps.join(
          ", ",
        )} — only $set is translatable (see task 997)`,
      );
    }
    const res = await pg.updateSessionByToken(
      token,
      set as Parameters<typeof pg.updateSessionByToken>[1],
    );
    await shadowWriteMongoIdentity("sessions.updateSessionByToken", () =>
      updateSessionByTokenMongo(token, update),
    );
    return res;
  }
  return updateSessionByTokenMongo(token, update);
}

async function updateSessionByTokenMongo(
  token: string,
  update: UpdateFilter<SessionDoc>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const col = await collection();
  const res = await col.updateOne({ token }, update);
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}

/**
 * Delete the session row matching the given token plus any extra
 * filter criteria the caller wants to enforce (e.g.
 * `{ isImpersonation: true }` so we only kill the ghost session, not
 * the operator's real one).
 */
export async function deleteSessionByToken(
  token: string,
  extraFilter: Filter<SessionDoc> = {},
): Promise<{ deletedCount: number }> {
  if (isIdentityPgCanonical()) {
    // Callers only ever narrow by `isImpersonation` (ghost-mode exit:
    // `{ isImpersonation: true }`). Translate that equality onto the
    // typed column; any other extra-filter key is a shape we don't
    // support — surface it loudly rather than delete the wrong row set.
    const { isImpersonation, ...unsupported } = extraFilter as {
      isImpersonation?: boolean;
      [k: string]: unknown;
    };
    const unsupportedKeys = Object.keys(unsupported);
    if (unsupportedKeys.length > 0) {
      throw new Error(
        `deleteSessionByToken (PG canonical): unsupported extra filter key(s) ${unsupportedKeys.join(
          ", ",
        )} — only isImpersonation is translatable (see task 997)`,
      );
    }
    const res = await pg.deleteSessionByToken(
      token,
      typeof isImpersonation === "boolean" ? { isImpersonation } : undefined,
    );
    await shadowWriteMongoIdentity("sessions.deleteSessionByToken", () =>
      deleteSessionByTokenMongo(token, extraFilter),
    );
    return res;
  }
  return deleteSessionByTokenMongo(token, extraFilter);
}

async function deleteSessionByTokenMongo(
  token: string,
  extraFilter: Filter<SessionDoc> = {},
): Promise<{ deletedCount: number }> {
  const col = await collection();
  const res = await col.deleteOne({ token, ...extraFilter });
  return { deletedCount: res.deletedCount };
}
