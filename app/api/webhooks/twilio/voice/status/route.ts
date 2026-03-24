import { NextRequest, NextResponse } from "next/server";
import { validateTwilioSignature } from "@/lib/twilio";
import { updateCommMessageByCallSid, updateCommConversation } from "@/lib/db/repositories/comm-conversations";
import { ensureCommunicationsTables } from "@/lib/db/init";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = String(value);
    });

    const signature = req.headers.get("x-twilio-signature") || "";
    const url = req.url;
    if (process.env.TWILIO_VALIDATE_SIGNATURE !== "false") {
      if (!validateTwilioSignature(url, params, signature)) {
        return new NextResponse("Forbidden", { status: 403 });
      }
    }

    await ensureCommunicationsTables();

    const callSid = params.CallSid || "";
    const callStatus = params.CallStatus || "";
    const callDuration = parseInt(params.CallDuration || "0", 10);

    if (!callSid) {
      return new NextResponse("OK", { status: 200 });
    }

    const updatedMessage = await updateCommMessageByCallSid(callSid, {
      call_status: callStatus,
      call_duration: callDuration || undefined,
    });

    if (updatedMessage && ["completed", "no-answer", "busy", "failed", "canceled"].includes(callStatus)) {
      const conversationStatus =
        callStatus === "completed" ? "closed" :
        callStatus === "no-answer" ? "missed" :
        callStatus === "busy" ? "missed" :
        callStatus === "failed" ? "closed" :
        "closed";

      await updateCommConversation(updatedMessage.conversation_id, {
        status: conversationStatus,
        closed_at: new Date().toISOString(),
      });
    }

    return new NextResponse("OK", { status: 200 });
  } catch (error: any) {
    console.error("Call status webhook error:", error);
    return new NextResponse("OK", { status: 200 });
  }
}
