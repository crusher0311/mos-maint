import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    const statsRows = await sql`
      SELECT 
        COUNT(*) FILTER (WHERE provider = 'autoflow' AND created_at >= ${oneHourAgo})::int as recent_events,
        COUNT(*) FILTER (WHERE provider = 'autoflow')::int as total_events,
        COUNT(*) FILTER (WHERE payload->'ticket'->>'roNumber' IS NOT NULL AND payload->'ticket'->>'roNumber' != '')::int as events_with_ro
      FROM events
    `;
    const stats = statsRows[0];
    
    console.log(`Dashboard refresh: ${stats.recent_events} events in last hour, ${stats.total_events} total, ${stats.events_with_ro} with RO#`);
    
    return NextResponse.json({ 
      success: true,
      stats: {
        recentEvents: stats.recent_events,
        totalEvents: stats.total_events,
        eventsWithRO: stats.events_with_ro,
        timestamp: now.toISOString()
      }
    });
    
  } catch (error) {
    console.error("Dashboard refresh cron error:", error);
    return NextResponse.json({ error: "Failed to refresh dashboard" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
