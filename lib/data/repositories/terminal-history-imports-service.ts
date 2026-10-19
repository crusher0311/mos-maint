import { getDb } from "@/lib/data/db";
import { readTerminalHistoryImports } from "./terminal-history-imports";
import { parseHistoryPage, type HistoryPageRequest } from "./terminal-history-pagination";

export async function getTerminalHistoryImports(request: HistoryPageRequest = {}) {
  parseHistoryPage(request);
  return readTerminalHistoryImports(await getDb(), request);
}
