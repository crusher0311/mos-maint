// app/api/cron/dashboard-refresh/route.ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export async function GET(request: Request) {
  try {
    // Verify this is called by Vercel Cron or authorized source
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDb();
    const events = db.collection("events");
    
    // Get stats about recent events
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    const recentEvents = await events.countDocuments({
      provider: "autoflow",
      createdAt: { $gte: oneHourAgo }
    });
    
    const totalEvents = await events.countDocuments({
      provider: "autoflow"
    });
    
    const eventsWithRO = await events.countDocuments({
      "payload.ticket.roNumber": { $exists: true, $ne: null, $ne: "" }
    });
    
    // Log some debug info for monitoring
    console.log(`Dashboard refresh: ${recentEvents} events in last hour, ${totalEvents} total, ${eventsWithRO} with RO#`);
    
    return NextResponse.json({ 
      success: true,
      stats: {
        recentEvents,
        totalEvents,
        eventsWithRO,
        timestamp: now.toISOString()
      }
    });
    
  } catch (error) {
    console.error("Dashboard refresh cron error:", error);
    return NextResponse.json({ error: "Failed to refresh dashboard" }, { status: 500 });
  }
}

// Allow POST as well for manual triggers
export async function POST(request: Request) {
  return GET(request);
}