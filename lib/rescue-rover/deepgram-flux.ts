import WebSocket from "ws";
import type { DeepgramFluxEvents } from "./types";

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

export class DeepgramFlux {
  private ws: WebSocket | null = null;
  private events: DeepgramFluxEvents;
  private apiKey: string;
  private utteranceBuffer: string = "";
  private closed = false;

  constructor(events: DeepgramFluxEvents) {
    this.events = events;
    this.apiKey = process.env.DEEPGRAM_API_KEY || "";
    if (!this.apiKey) {
      throw new Error("DEEPGRAM_API_KEY is required");
    }
  }

  connect(): void {
    const params = new URLSearchParams({
      model: "nova-2",
      encoding: "mulaw",
      sample_rate: "8000",
      channels: "1",
      punctuate: "true",
      interim_results: "true",
      endpointing: "260",
      utterance_end_ms: "1200",
      vad_events: "true",
      smart_format: "true",
    });

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
      },
    });

    this.ws.on("open", () => {
      console.log("[DeepgramFlux] Connected");
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error("[DeepgramFlux] WebSocket error:", err.message);
      this.events.onError(err);
    });

    this.ws.on("close", () => {
      console.log("[DeepgramFlux] Connection closed");
      if (!this.closed) {
        this.events.onClose();
      }
    });
  }

  sendAudio(audioData: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(audioData);
    }
  }

  private handleMessage(msg: any): void {
    if (msg.type === "Results") {
      const transcript = msg.channel?.alternatives?.[0]?.transcript || "";
      const isFinal = msg.is_final === true;
      const speechFinal = msg.speech_final === true;

      if (transcript) {
        this.events.onTranscript(transcript, isFinal);

        if (isFinal) {
          this.utteranceBuffer += (this.utteranceBuffer ? " " : "") + transcript;
        }

        if (speechFinal && this.utteranceBuffer.trim()) {
          this.events.onEndOfTurn(this.utteranceBuffer.trim());
          this.utteranceBuffer = "";
        }
      }
    } else if (msg.type === "UtteranceEnd") {
      if (this.utteranceBuffer.trim()) {
        this.events.onEndOfTurn(this.utteranceBuffer.trim());
        this.utteranceBuffer = "";
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
        }
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
