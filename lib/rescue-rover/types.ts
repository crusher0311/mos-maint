export interface RescueRoverConfig {
  shopId: number;
  enabled: boolean;
  voiceId: string;
  voiceProvider: string;
  greeting: string;
  afterHoursGreeting: string;
  maxCallDuration: number;
  transferNumber: string | null;
  enableTranscription: boolean;
  enableSentimentAnalysis: boolean;
  language: string;
  timezone: string;
  businessHours: BusinessHours | null;
  customInstructions: string | null;
}

export interface BusinessHours {
  [day: string]: { open: string; close: string } | null;
}

export interface CallSession {
  callSid: string;
  streamSid: string | null;
  shopId: number;
  callerPhone: string;
  callerName: string | null;
  config: RescueRoverConfig;
  startedAt: Date;
  transcript: TranscriptEntry[];
  tokensUsed: { input: number; output: number };
  deepgramCost: number;
  outcome: CallOutcome;
  intentDetected: string | null;
  transferredTo: string | null;
  appointmentScheduled: boolean;
}

export interface TranscriptEntry {
  role: "caller" | "assistant";
  content: string;
  timestamp: Date;
}

export type CallOutcome =
  | "answered"
  | "voicemail"
  | "missed"
  | "failed"
  | "transferred"
  | "callback_scheduled";

export interface SafetyRule {
  id: number;
  name: string;
  description: string | null;
  ruleType: string;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  priority: number;
}

export interface CustomerContext {
  name: string | null;
  phone: string;
  vehicles: VehicleContext[];
}

export interface VehicleContext {
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  vhiScore: number | null;
  vhiTier: string | null;
  overdueItems: string[];
  dueSoonItems: string[];
}

export interface DeepgramFluxEvents {
  onTranscript: (text: string, isFinal: boolean) => void;
  onEndOfTurn: (fullUtterance: string) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export interface ConversationTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}
