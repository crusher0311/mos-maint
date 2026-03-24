import { NextResponse } from "next/server";
import { getClient } from "@/lib/db/drizzle";

const CRM_TABLES = [
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
];

export async function GET() {
  const results: Record<string, unknown> = {};
  const errors: string[] = [];

  let supabaseStatus = "disconnected";
  try {
    const pgClient = getClient();
    const pingResult = await pgClient`SELECT 1 as ok`;
    if (pingResult.length > 0) {
      supabaseStatus = "connected";
    }

    const tableCounts: Record<string, number> = {};
    for (const table of CRM_TABLES) {
      try {
        const countResult = await pgClient.unsafe(
          `SELECT COUNT(*) as count FROM "${table}"`,
        );
        tableCounts[table] = Number(countResult[0]?.count ?? 0);
      } catch (tableErr: unknown) {
        tableCounts[table] = -1;
        const msg = tableErr instanceof Error ? tableErr.message : String(tableErr);
        errors.push(`${table}: ${msg}`);
      }
    }

    results.supabase = {
      status: supabaseStatus,
      tableCounts,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.supabase = {
      status: "error",
      error: msg,
    };
    errors.push(`Supabase: ${msg}`);
  }

  let mongoStatus = "disconnected";
  try {
    const { getMongoClient } = await import("@/lib/mongo");
    const client = await getMongoClient();
    await client.db("admin").command({ ping: 1 });
    mongoStatus = "connected";
    results.mongodb = { status: mongoStatus };
  } catch (err: unknown) {
    mongoStatus = "error";
    const msg = err instanceof Error ? err.message : String(err);
    results.mongodb = { status: mongoStatus, error: msg };
    errors.push(`MongoDB: ${msg}`);
  }

  const allHealthy =
    supabaseStatus === "connected" &&
    mongoStatus === "connected" &&
    errors.length === 0;

  return NextResponse.json(
    {
      healthy: allHealthy,
      timestamp: new Date().toISOString(),
      databases: results,
      errors: errors.length > 0 ? errors : undefined,
    },
    { status: allHealthy ? 200 : 503 },
  );
}
