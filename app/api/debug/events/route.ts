import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export async function GET() {
  try {
    const sampleEventResult = await sql`
      SELECT * FROM events WHERE provider = 'autoflow' LIMIT 1
    `;
    const sampleEvent = sampleEventResult[0];
    
    const eventsWithROResult = await sql`
      SELECT * FROM events 
      WHERE payload->>'ticket' IS NOT NULL 
        AND payload->'ticket'->>'roNumber' IS NOT NULL 
      LIMIT 1
    `;
    const eventsWithRO = eventsWithROResult[0];
    
    const recentEvents = await sql`
      SELECT * FROM events 
      WHERE provider = 'autoflow'
      ORDER BY created_at DESC 
      LIMIT 3
    `;
    
    const eventsData = recentEvents.map((event, i) => {
      const payload = (event.payload as Record<string, unknown>) || {};
      const ticket = (payload.ticket as Record<string, unknown>) || {};
      return {
        index: i + 1,
        ro: ticket.roNumber || 'MISSING',
        status: ticket.status || event.status || 'MISSING',
        createdAt: event.created_at,
        vin: event.vehicle_vin || event.vin || (payload.vehicle as Record<string, unknown>)?.vin || 'MISSING',
        payloadStructure: {
          hasTicket: !!ticket,
          hasRoNumber: !!ticket.roNumber,
          hasStatus: !!ticket.status,
          ticketKeys: Object.keys(ticket)
        }
      };
    });
    
    const totalAutoflowResult = await sql`
      SELECT COUNT(*) as count FROM events WHERE provider = 'autoflow'
    `;
    const totalAutoflowEvents = Number(totalAutoflowResult[0]?.count) || 0;
    
    const eventsWithROCountResult = await sql`
      SELECT COUNT(*) as count FROM events 
      WHERE provider = 'autoflow'
        AND payload->'ticket'->>'roNumber' IS NOT NULL 
        AND payload->'ticket'->>'roNumber' != ''
    `;
    const eventsWithROCount = Number(eventsWithROCountResult[0]?.count) || 0;
    
    const samplePayload = (sampleEvent?.payload as Record<string, unknown>) || {};
    const sampleTicket = (samplePayload.ticket as Record<string, unknown>) || {};
    
    const eventsWithROPayload = (eventsWithRO?.payload as Record<string, unknown>) || {};
    const eventsWithROTicket = (eventsWithROPayload.ticket as Record<string, unknown>) || {};
    
    return NextResponse.json({
      sampleEvent: sampleEvent ? {
        _id: sampleEvent.id,
        provider: sampleEvent.provider,
        createdAt: sampleEvent.created_at,
        hasPayload: !!samplePayload,
        hasTicket: !!sampleTicket,
        ticketFields: Object.keys(sampleTicket),
        roNumber: sampleTicket.roNumber
      } : null,
      eventsWithRO: eventsWithRO ? {
        _id: eventsWithRO.id,
        roNumber: eventsWithROTicket.roNumber,
        status: eventsWithROTicket.status
      } : null,
      recentEventsAnalysis: eventsData,
      totalAutoflowEvents,
      eventsWithROCount
    });
    
  } catch (error) {
    console.error("Debug events error:", error);
    return NextResponse.json({ error: "Failed to debug events" }, { status: 500 });
  }
}
