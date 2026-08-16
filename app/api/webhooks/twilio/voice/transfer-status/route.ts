import { NextRequest, NextResponse } from "next/server";
import { validateTwilioSignature } from "@/lib/twilio";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => { params[key] = String(value); });

    const signature = req.headers.get("x-twilio-signature") || "";
    if (process.env.TWILIO_VALIDATE_SIGNATURE !== "false") {
      if (!validateTwilioSignature(req.url, params, signature)) {
        return new NextResponse("Forbidden", { status: 403 });
      }
    }

    const dialCallStatus = params["DialCallStatus"] || "";
    const callSid = params["CallSid"] || "";

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
