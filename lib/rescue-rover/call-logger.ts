import { createCallLog } from "@/lib/db/repositories/rescue-rover";
import { logApiUsage, estimateTotalCallCost } from "./cost-tracking";
import type { CallSession } from "./types";

export async function finalizeCallLog(session: CallSession): Promise<void> {
  try {
    const durationSeconds = Math.round(
      (Date.now() - session.startedAt.getTime()) / 1000,
    );

    const transcriptText = session.transcript
      .map(
        (t) =>
          `[${t.role === "caller" ? "Caller" : "Rescue Rover"}] ${t.content}`,
      )
      .join("\n");

    const ttsCharacters = session.transcript
      .filter((t) => t.role === "assistant")
      .reduce((sum, t) => sum + t.content.length, 0);

    const costEstimate = estimateTotalCallCost({
      durationSeconds,
      ttsCharacters,
      inputTokens: session.tokensUsed.input,
      outputTokens: session.tokensUsed.output,
    });

    await createCallLog({
      shopId: session.shopId,
      callSid: session.callSid,
      callerPhone: session.callerPhone,
      callerName: session.callerName,
      duration: durationSeconds,
      outcome: session.outcome,
      transcription: transcriptText || null,
      summary: null,
      intentDetected: session.intentDetected,
      appointmentScheduled: session.appointmentScheduled,
      transferredTo: session.transferredTo,
      tokensUsed:
        session.tokensUsed.input + session.tokensUsed.output,
      costEstimate,
      metadata: {
        inputTokens: session.tokensUsed.input,
        outputTokens: session.tokensUsed.output,
        ttsCharacters,
        deepgramCost: session.deepgramCost,
      },
    });

    await logApiUsage({
      shopId: session.shopId,
      service: "rescue-rover-call",
      endpoint: "voice-call",
      method: "INBOUND",
      tokensInput: session.tokensUsed.input,
      tokensOutput: session.tokensUsed.output,
      totalTokens: session.tokensUsed.input + session.tokensUsed.output,
      costEstimate,
      latencyMs: durationSeconds * 1000,
      metadata: {
        callSid: session.callSid,
        callerPhone: session.callerPhone,
        outcome: session.outcome,
        durationSeconds,
      },
    });

    console.log(
      `[RescueRover] Call logged: ${session.callSid} duration=${durationSeconds}s cost=$${costEstimate.toFixed(4)} outcome=${session.outcome}`,
    );
  } catch (err) {
    console.error("[RescueRover] Failed to finalize call log:", err);
  }
}
