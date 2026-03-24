import { getClient } from "./drizzle";

export function getPostgresClient() {
  return getClient();
}
