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
      endpointing: "300",
      utterance_end_ms: "1000",
      vad_events: "true",
      smart_format: "true",
      keywords: [
        "VIN:2", "oil change:2", "brake:2", "transmission:2", "alignment:2",
        "diagnostic:2", "check engine:2", "tire rotation:2", "coolant:2",
        "spark plug:2", "timing belt:2", "serpentine belt:2", "radiator:2",
        "alternator:2", "battery:2", "catalytic converter:2", "exhaust:2",
        "suspension:2", "strut:2", "caliper:2", "rotor:2", "muffler:2",
        "Toyota:1", "Honda:1", "Ford:1", "Chevrolet:1", "Chevy:1",
        "Nissan:1", "Hyundai:1", "Kia:1", "BMW:1", "Mercedes:1",
        "Subaru:1", "Mazda:1", "Volkswagen:1", "Jeep:1", "Dodge:1",
        "RAM:1", "GMC:1", "Buick:1", "Cadillac:1", "Lexus:1", "Acura:1",
        "appointment:1", "estimate:1", "quote:1", "warranty:1",
        "Rescue Rover:2", "service advisor:1"
      ].join(","),
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
