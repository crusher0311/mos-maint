import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const dialCallStatus = formData.get("DialCallStatus")?.toString() || "";
    const callSid = formData.get("CallSid")?.toString() || "";

    console.log(
      `[Twilio Transfer] Status: ${dialCallStatus} for call ${callSid}`,
    );

    if (
      dialCallStatus === "no-answer" ||
      dialCallStatus === "busy" ||
      dialCallStatus === "failed"
    ) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, no one is available right now. Please leave a message after the beep.</Say><Record maxLength="120" action="/api/webhooks/twilio/voice/voicemail" transcribe="true" /><Hangup/></Response>`;
      return new NextResponse(twiml, {
        headers: { "Content-Type": "text/xml" },
      });
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
    return new NextResponse(twiml, {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (err) {
    console.error("[Twilio Transfer Status] Error:", err);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
    return new NextResponse(twiml, {
      headers: { "Content-Type": "text/xml" },
    });
  }
}
