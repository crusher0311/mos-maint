import { ensureCommConversationsTable, ensureCommMessagesTable } from "./repositories/comm-conversations";
import { ensureCommVoicemailsTable } from "./repositories/comm-voicemails";

let initialized = false;

export async function ensureCommunicationsTables() {
  if (initialized) return;

  try {
    await ensureCommConversationsTable();
    await ensureCommMessagesTable();
    await ensureCommVoicemailsTable();
    initialized = true;
  } catch (error) {
    console.error("Failed to initialize communications tables:", error);
    throw error;
  }
}
