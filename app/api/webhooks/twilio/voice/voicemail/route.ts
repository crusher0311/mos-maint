import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const recordingUrl = formData.get("RecordingUrl")?.toString() || "";
    const recordingSid = formData.get("RecordingSid")?.toString() || "";
    const recordingDuration =
      formData.get("RecordingDuration")?.toString() || "0";
    const callSid = formData.get("CallSid")?.toString() || "";
    const from = formData.get("From")?.toString() || "";
    const to = formData.get("To")?.toString() || "";
    const transcriptionText =
      formData.get("TranscriptionText")?.toString() || "";

    console.log(
      `[Twilio Voicemail] Recording received: sid=${recordingSid} duration=${recordingDuration}s from=${from}`,
    );

    try {
      const { getDb } = await import("@/lib/db/drizzle");
      const { voicemails } = await import("@/lib/db/schema");
      const db = getDb();

      await db.insert(voicemails).values({
        shopId: 0,
        callerPhone: from,
        recipientPhone: to,
        duration: parseInt(recordingDuration, 10),
        recordingUrl: recordingUrl ? `${recordingUrl}.mp3` : null,
        recordingSid,
        transcription: transcriptionText || null,
        transcriptionStatus: transcriptionText ? "completed" : "pending",
      });
    } catch (dbErr) {
      console.error("[Twilio Voicemail] DB save error:", dbErr);
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thank you for your message. We'll get back to you as soon as possible. Goodbye!</Say><Hangup/></Response>`;
    return new NextResponse(twiml, {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (err) {
    console.error("[Twilio Voicemail] Error:", err);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
    return new NextResponse(twiml, {
      headers: { "Content-Type": "text/xml" },
    });
  }
}
