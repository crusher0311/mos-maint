import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function getConnectionString(): string {
  const url = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Missing database URL. Set DATAONE_DATABASE_URL or DATABASE_URL.",
    );
  }
  return url;
}

export function getClient(): ReturnType<typeof postgres> {
  if (!_client) {
    _client = postgres(getConnectionString(), {
      max: 2,
      idle_timeout: 30,
      connect_timeout: 30,
      max_lifetime: 60 * 30,
    });
  }
  return _client;
}

export function getDb() {
  if (!_db) {
    _db = drizzle(getClient(), { schema });
  }
  return _db;
}

export { schema };
