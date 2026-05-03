// app/api/debug/events/route.ts
import { NextResponse } from "next/server";
import {
  countEvents,
  findOneEvent,
  listRecentEvents,
} from "@/lib/data/repositories/events";

export async function GET() {
  try {
    const sampleEvent = await findOneEvent({ provider: "autoflow" });

    const eventsWithRO = await findOneEvent({
      "payload.ticket.roNumber": { $exists: true, $ne: null } as any,
    });

    const recentEvents = await listRecentEvents(
      { provider: "autoflow" },
      { sort: { createdAt: -1 }, limit: 3 },
    );

    const eventsData = recentEvents.map((event: any, i: number) => ({
      index: i + 1,
      ro: event.payload?.ticket?.roNumber || 'MISSING',
      status: event.payload?.ticket?.status || event.status || 'MISSING',
      createdAt: event.createdAt,
      vin: event.vehicleVin || event.vin || event.payload?.vehicle?.vin || 'MISSING',
      payloadStructure: {
        hasTicket: !!event.payload?.ticket,
        hasRoNumber: !!event.payload?.ticket?.roNumber,
        hasStatus: !!event.payload?.ticket?.status,
        ticketKeys: event.payload?.ticket ? Object.keys(event.payload.ticket) : [],
      },
    }));

    return NextResponse.json({
      sampleEvent: sampleEvent ? {
        _id: sampleEvent._id,
        provider: sampleEvent.provider,
        createdAt: sampleEvent.createdAt,
        hasPayload: !!sampleEvent.payload,
        hasTicket: !!(sampleEvent.payload as any)?.ticket,
        ticketFields: (sampleEvent.payload as any)?.ticket
          ? Object.keys((sampleEvent.payload as any).ticket)
          : [],
        roNumber: (sampleEvent.payload as any)?.ticket?.roNumber,
      } : null,
      eventsWithRO: eventsWithRO ? {
        _id: eventsWithRO._id,
        roNumber: (eventsWithRO.payload as any)?.ticket?.roNumber,
        status: (eventsWithRO.payload as any)?.ticket?.status,
      } : null,
      recentEventsAnalysis: eventsData,
      totalAutoflowEvents: await countEvents({ provider: "autoflow" }),
      eventsWithROCount: await countEvents({
        "payload.ticket.roNumber": { $exists: true, $ne: null, $ne: "" } as any,
      }),
    });

  } catch (error) {
    console.error("Debug events error:", error);
    return NextResponse.json({ error: "Failed to debug events" }, { status: 500 });
  }
}
