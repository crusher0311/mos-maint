// lib/data/db.ts
//
// Internal: every repository under lib/data/repositories/ MUST get its
// MongoDB handle from this module. This is the only place outside
// `lib/mongo.ts` that is allowed to import `getDb` / `getMongoClient`
// directly. Application code MUST NOT import from here — use a
// repository instead. The `scripts/check-direct-db.cjs` lint enforces
// this.
export { getDb, getMongoClient } from "@/lib/mongo";
