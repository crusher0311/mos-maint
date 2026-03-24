import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATAONE_DATABASE_URL!,
  },
  tablesFilter: [
    "conversations",
    "conversation_messages",
    "conversation_participants",
    "phone_numbers",
    "sms_contacts",
    "sms_messages",
    "voicemails",
    "call_transcriptions",
    "rescue_rover_settings",
    "rescue_rover_call_logs",
    "rescue_rover_safety_rules",
    "rescue_rover_prompt_templates",
    "rescue_rover_voice_scripts",
    "rescue_rover_context_rules",
    "rescue_rover_rcs_links",
    "api_usage_logs",
  ],
});
