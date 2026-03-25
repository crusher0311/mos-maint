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
  | "callback_scheduled"
  | "ticket_created";

export interface SafetyRule {
  id: number;
  name: string;
  description: string | null;
  ruleType: string;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  priority: number;
}

export interface ClientContext {
  shopId: number;
  shopName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string;
  billing: {
    status: string;
    plan: string | null;
    stripeCustomerId: string | null;
  };
  integrations: {
    protractor: boolean;
    tekmetric: boolean;
    shopware: boolean;
    autoflow: boolean;
    carfax: boolean;
    smsProvider: string | null;
  };
  enabledFeatures: string[];
  vehicleCount: number;
  lastActivity: Date | null;
  openTickets: number;
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
