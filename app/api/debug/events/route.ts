// app/api/debug/events/route.ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
    const db = await getDb();
    
    // Get a sample event to see the structure
    const sampleEvent = await db.collection("events").findOne({
      provider: "autoflow"
    });
    
    // Check for RO numbers
    const eventsWithRO = await db.collection("events").findOne({
      "payload.ticket.roNumber": { $exists: true, $ne: null }
    });
    
    // Check recent events structure
    const recentEvents = await db.collection("events").find({
      provider: "autoflow"
    }).sort({ createdAt: -1 }).limit(3).toArray();
    
    const eventsData = recentEvents.map((event, i) => ({
      index: i + 1,
      ro: event.payload?.ticket?.roNumber || 'MISSING',
      status: event.payload?.ticket?.status || event.status || 'MISSING',
      createdAt: event.createdAt,
      vin: event.vehicleVin || event.vin || event.payload?.vehicle?.vin || 'MISSING',
      payloadStructure: {
        hasTicket: !!event.payload?.ticket,
        hasRoNumber: !!event.payload?.ticket?.roNumber,
        hasStatus: !!event.payload?.ticket?.status,
        ticketKeys: event.payload?.ticket ? Object.keys(event.payload.ticket) : []
      }
    }));
    
    return NextResponse.json({
      sampleEvent: sampleEvent ? {
        _id: sampleEvent._id,
        provider: sampleEvent.provider,
        createdAt: sampleEvent.createdAt,
        hasPayload: !!sampleEvent.payload,
        hasTicket: !!sampleEvent.payload?.ticket,
        ticketFields: sampleEvent.payload?.ticket ? Object.keys(sampleEvent.payload.ticket) : [],
        roNumber: sampleEvent.payload?.ticket?.roNumber
      } : null,
      eventsWithRO: eventsWithRO ? {
        _id: eventsWithRO._id,
        roNumber: eventsWithRO.payload?.ticket?.roNumber,
        status: eventsWithRO.payload?.ticket?.status
      } : null,
      recentEventsAnalysis: eventsData,
      totalAutoflowEvents: await db.collection("events").countDocuments({ provider: "autoflow" }),
      eventsWithROCount: await db.collection("events").countDocuments({
        "payload.ticket.roNumber": { $exists: true, $ne: null, $ne: "" }
      })
    });
    
  } catch (error) {
    console.error("Debug events error:", error);
    return NextResponse.json({ error: "Failed to debug events" }, { status: 500 });
  }
}