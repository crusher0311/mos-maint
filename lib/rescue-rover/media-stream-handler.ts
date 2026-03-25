import WebSocket from "ws";
import { DeepgramFlux } from "./deepgram-flux";
import { synthesizeSpeech, chunkMulawAudio } from "./deepgram-tts";
import { ConversationEngine } from "./conversation";
import { finalizeCallLog } from "./call-logger";
import { getRescueRoverSettings } from "@/lib/db/repositories/rescue-rover";
import type { CallSession, RescueRoverConfig } from "./types";

const FRAME_SIZE = 160;
const PACING_INTERVAL_MS = 20;
const DEFAULT_MAX_DURATION = 300;
const BARGE_IN_THRESHOLD_MS = 500;

interface ActiveCall {
  session: CallSession;
  conversation: ConversationEngine;
  deepgram: DeepgramFlux;
  audioQueue: Buffer[];
  isSpeaking: boolean;
  isProcessing: boolean;
  pacingTimer: ReturnType<typeof setInterval> | null;
  callTimer: ReturnType<typeof setTimeout> | null;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  speakingStartedAt: number;
  ws: WebSocket;
}

const activeCalls = new Map<string, ActiveCall>();

export async function handleMediaStream(ws: WebSocket): Promise<void> {
  let currentCall: ActiveCall | null = null;
  let streamSid: string | null = null;

  ws.on("message", async (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          console.log("[MediaStream] Connected");
          break;

        case "start":
          streamSid = msg.start?.streamSid || null;
          const callSid = msg.start?.callSid || "";
          const customParams = msg.start?.customParameters || {};
          const shopId = parseInt(customParams.shopId || "0", 10);

          if (!shopId) {
            console.error("[MediaStream] No shopId in custom parameters");
            ws.close();
            return;
          }

          console.log(
            `[MediaStream] Stream started: ${streamSid} callSid=${callSid} shopId=${shopId}`,
          );

          currentCall = await initializeCall(ws, callSid, shopId, customParams);
          if (currentCall && streamSid) {
            currentCall.session.streamSid = streamSid;
            activeCalls.set(streamSid, currentCall);
          }
          break;

        case "media":
          if (currentCall) {
            const audioPayload = Buffer.from(msg.media.payload, "base64");

            if (currentCall.isSpeaking && !currentCall.isProcessing) {
              const elapsed = Date.now() - currentCall.speakingStartedAt;
              if (elapsed > BARGE_IN_THRESHOLD_MS) {
                console.log("[MediaStream] Barge-in detected, stopping playback");
                stopAudioPlayback(currentCall);
                currentCall.isSpeaking = false;
              }
            }

            currentCall.deepgram.sendAudio(audioPayload);
          }
          break;

        case "stop":
          console.log(`[MediaStream] Stream stopped: ${streamSid}`);
          if (currentCall) {
            await cleanupCall(currentCall, streamSid);
            currentCall = null;
          }
          break;
      }
    } catch (err) {
      console.error("[MediaStream] Message handling error:", err);
    }
  });

  ws.on("close", async () => {
    console.log(`[MediaStream] WebSocket closed: ${streamSid}`);
    if (currentCall) {
      await cleanupCall(currentCall, streamSid);
      currentCall = null;
    }
  });

  ws.on("error", async (err) => {
    console.error(`[MediaStream] WebSocket error:`, err.message);
    if (currentCall) {
      await cleanupCall(currentCall, streamSid);
      currentCall = null;
    }
  });
}

async function initializeCall(
  ws: WebSocket,
  callSid: string,
  shopId: number,
  customParams: Record<string, string>,
): Promise<ActiveCall | null> {
  try {
    const settings = await getRescueRoverSettings(shopId);
    const config: RescueRoverConfig = {
      shopId,
      enabled: settings?.enabled ?? false,
      voiceId: settings?.voiceId || "aura-asteria-en",
      voiceProvider: settings?.voiceProvider || "deepgram",
      greeting: settings?.greeting || "",
      afterHoursGreeting: settings?.afterHoursGreeting || "",
      maxCallDuration: settings?.maxCallDuration || DEFAULT_MAX_DURATION,
      transferNumber: settings?.transferNumber || null,
      enableTranscription: settings?.enableTranscription ?? true,
      enableSentimentAnalysis: settings?.enableSentimentAnalysis ?? false,
      language: settings?.language || "en",
      timezone: settings?.timezone || "America/New_York",
      businessHours: (settings?.businessHours as any) || null,
      customInstructions: settings?.customInstructions || null,
    };

    const session: CallSession = {
      callSid,
      streamSid: null,
      shopId,
      callerPhone: customParams.callerPhone || "",
      callerName: null,
      config,
      startedAt: new Date(),
      transcript: [],
      tokensUsed: { input: 0, output: 0 },
      deepgramCost: 0,
      outcome: "answered",
      intentDetected: null,
      transferredTo: null,
      appointmentScheduled: false,
    };

    const conversation = new ConversationEngine(session);

    const call: ActiveCall = {
      session,
      conversation,
      deepgram: null as any,
      audioQueue: [],
      isSpeaking: false,
      isProcessing: false,
      pacingTimer: null,
      callTimer: null,
      silenceTimer: null,
      speakingStartedAt: 0,
      ws,
    };

    const deepgram = new DeepgramFlux({
      onTranscript: () => {
        resetSilenceTimer(call);
      },
      onEndOfTurn: async (utterance: string) => {
        console.log(`[MediaStream] Caller said: "${utterance}"`);

        if (call.silenceTimer) {
          clearTimeout(call.silenceTimer);
          call.silenceTimer = null;
        }

        call.isProcessing = true;
        stopAudioPlayback(call);
        call.isSpeaking = false;

        try {
          const response = await conversation.processUserInput(utterance);
          console.log(`[MediaStream] AI response: "${response}"`);
          call.isProcessing = false;
          await speakResponse(call, response);
        } catch (err) {
          console.error("[MediaStream] Response error:", err);
          call.isProcessing = false;
          call.isSpeaking = false;
        }

        if (session.outcome === "transferred" && config.transferNumber) {
          await handleTransfer(call, config.transferNumber);
        }

        resetSilenceTimer(call);
      },
      onError: (err: Error) => {
        console.error("[MediaStream] Deepgram error:", err.message);
        if (call.ws.readyState === WebSocket.OPEN) {
          cleanupCall(call, call.session.streamSid).catch(() => {});
        }
      },
      onClose: () => {
        console.log("[MediaStream] Deepgram connection closed");
        if (call.ws.readyState === WebSocket.OPEN) {
          cleanupCall(call, call.session.streamSid).catch(() => {});
        }
      },
    });

    call.deepgram = deepgram;
    deepgram.connect();

    const greeting = await conversation.initialize();
    await speakResponse(call, greeting);

    call.callTimer = setTimeout(async () => {
      console.log(
        `[MediaStream] Max call duration reached: ${config.maxCallDuration}s`,
      );
      const farewell =
        "I appreciate your time, but I need to wrap up our call. Please call back if you need further assistance. Goodbye!";
      await speakResponse(call, farewell);
      setTimeout(() => {
        ws.close();
      }, 3000);
    }, config.maxCallDuration * 1000);

    resetSilenceTimer(call);

    return call;
  } catch (err) {
    console.error("[MediaStream] Failed to initialize call:", err);
    return null;
  }
}

function resetSilenceTimer(call: ActiveCall): void {
  if (call.silenceTimer) {
    clearTimeout(call.silenceTimer);
  }

  call.silenceTimer = setTimeout(async () => {
    if (call.isSpeaking || call.isProcessing) {
      resetSilenceTimer(call);
      return;
    }

    console.log("[MediaStream] Silence detected, prompting caller");
    const prompt = "Are you still there? Is there anything else I can help with?";
    call.session.transcript.push({
      role: "assistant",
      content: prompt,
      timestamp: new Date(),
    });
    await speakResponse(call, prompt);
  }, 15000);
}

async function speakResponse(call: ActiveCall, text: string): Promise<void> {
  try {
    const ttsResult = await synthesizeSpeech(text, call.session.config.voiceId);
    const frames = chunkMulawAudio(ttsResult.audio, FRAME_SIZE);

    call.audioQueue = frames;
    call.isSpeaking = true;
    call.speakingStartedAt = Date.now();
    startAudioPlayback(call);
  } catch (err) {
    console.error("[MediaStream] TTS error:", err);
    call.isSpeaking = false;
  }
}

function startAudioPlayback(call: ActiveCall): void {
  if (call.pacingTimer) return;

  call.pacingTimer = setInterval(() => {
    if (call.audioQueue.length === 0) {
      stopAudioPlayback(call);
      call.isSpeaking = false;
      return;
    }

    const frame = call.audioQueue.shift()!;
    if (call.ws.readyState === WebSocket.OPEN && call.session.streamSid) {
      const mediaMessage = {
        event: "media",
        streamSid: call.session.streamSid,
        media: {
          payload: frame.toString("base64"),
        },
      };
      call.ws.send(JSON.stringify(mediaMessage));
    }
  }, PACING_INTERVAL_MS);
}

function stopAudioPlayback(call: ActiveCall): void {
  if (call.pacingTimer) {
    clearInterval(call.pacingTimer);
    call.pacingTimer = null;
  }
  call.audioQueue = [];

  if (call.ws.readyState === WebSocket.OPEN && call.session.streamSid) {
    call.ws.send(
      JSON.stringify({
        event: "clear",
        streamSid: call.session.streamSid,
      }),
    );
  }
}

async function handleTransfer(
  call: ActiveCall,
  transferNumber: string,
): Promise<void> {
  try {
    const twilio = await import("twilio");
    const client = twilio.default(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
    );

    const farewell =
      "Let me connect you with a team member now. Please hold for just a moment.";
    await speakResponse(call, farewell);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    await client.calls(call.session.callSid).update({
      twiml: `<Response><Dial timeout="30" action="/api/webhooks/twilio/voice/transfer-status"><Number>${transferNumber}</Number></Dial><Say>Sorry, no one is available right now. Please leave a message after the beep.</Say><Record maxLength="120" action="/api/webhooks/twilio/voice/voicemail" transcribe="true" /></Response>`,
    });

    call.session.outcome = "transferred";
    call.session.transferredTo = transferNumber;
  } catch (err) {
    console.error("[MediaStream] Transfer failed:", err);
    const fallback =
      "I'm sorry, I wasn't able to connect you right now. Would you like to leave a message instead?";
    await speakResponse(call, fallback);
    call.session.outcome = "voicemail";
  }
}

const cleanedUp = new Set<string>();

async function cleanupCall(
  call: ActiveCall,
  streamSid: string | null,
): Promise<void> {
  const key = streamSid || call.session.callSid;
  if (cleanedUp.has(key)) return;
  cleanedUp.add(key);

  try {
    if (call.callTimer) {
      clearTimeout(call.callTimer);
      call.callTimer = null;
    }
    if (call.silenceTimer) {
      clearTimeout(call.silenceTimer);
      call.silenceTimer = null;
    }
    stopAudioPlayback(call);
    call.deepgram.close();

    const summary = await call.conversation.generateCallSummary();
    if (summary) {
      (call.session as any)._generatedSummary = summary;
    }

    await finalizeCallLog(call.session);

    if (streamSid) {
      activeCalls.delete(streamSid);
    }
  } catch (err) {
    console.error("[MediaStream] Cleanup error:", err);
  } finally {
    setTimeout(() => cleanedUp.delete(key), 60_000);
  }
}
