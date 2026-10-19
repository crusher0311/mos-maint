import { getDb } from "@/lib/data/db";
import { readTerminalHistoryImports } from "./terminal-history-imports";

export async function getTerminalHistoryImports() {
  return readTerminalHistoryImports(await getDb());
}
