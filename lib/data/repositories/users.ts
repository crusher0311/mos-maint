// Repository for the `users` collection — only the operations the
// migrated callers actually need. Broader user CRUD still lives in
// `lib/auth.ts`; this is a deliberately narrow surface for callers
// like announcements / targeting.
import type { Collection, Filter, ObjectId as ObjectIdType } from "mongodb";
import { getDb } from "@/lib/data/db";

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
  const col = await collection();
  const cursor = col.find(query);
  if (projection) cursor.project(projection);
  return cursor.toArray() as Promise<UserDoc[]>;
}
