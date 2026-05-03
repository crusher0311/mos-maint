// Repository for the `sessions` collection.
//
// `lib/auth.ts` still owns the heavyweight session creation/cleanup
// flow; this is a deliberately narrow surface for callers that just
// need to look up or mutate a single row by token. The `lib/auth.ts`
// migration is tracked separately because that file mixes sessions,
// users, password-reset tokens, and rate-limit state.
import type { Collection, Filter, UpdateFilter } from "mongodb";
import { getDb } from "@/lib/data/db";

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
  const col = await collection();
  const res = await col.deleteOne({ token, ...extraFilter });
  return { deletedCount: res.deletedCount };
}
