import OpenAI from "openai";
import type {
  CallSession,
  RescueRoverConfig,
  CustomerContext,
  SafetyRule,
  ConversationTool,
  TranscriptEntry,
} from "./types";
import { loadSafetyRules, buildSafetyPrompt } from "./safety-rules";
import {
  lookupCustomerByPhone,
  buildCustomerContextPrompt,
} from "./customer-context";
import { logApiUsage } from "./cost-tracking";

const openai = new OpenAI();

const DEFAULT_SYSTEM_PROMPT = `You are Rescue Rover, a friendly and knowledgeable AI phone assistant for an automotive repair shop. Your role is to:

1. Greet callers warmly and professionally
2. Answer questions about the shop's services, hours, and location
3. Help customers understand their vehicle's maintenance needs
4. Schedule callback requests when needed
5. Transfer calls to human staff when you cannot help or when requested

Communication style:
- Be concise — phone conversations should be brief and clear
- Speak naturally, as if talking to a friend
- Use simple language, avoid technical jargon unless the caller uses it
- Confirm understanding before taking action
- Never make up information you don't have

Important:
- You cannot actually book appointments — only note the request for a callback
- Always offer to transfer to a human if the caller seems frustrated or the topic is beyond your scope
- Never discuss pricing or provide estimates — say staff will discuss that
- Keep responses under 2-3 sentences when possible for natural phone conversation`;

interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export class ConversationEngine {
  private messages: ConversationMessage[] = [];
  private session: CallSession;
  private tools: ConversationTool[] = [];
  private customerContext: CustomerContext | null = null;
  private ttsCharacters = 0;

  constructor(session: CallSession) {
    this.session = session;
    this.setupTools();
  }

  async initialize(): Promise<string> {
    const [safetyRules, customerCtx] = await Promise.all([
      loadSafetyRules(this.session.shopId),
      lookupCustomerByPhone(this.session.callerPhone, this.session.shopId),
    ]);

    this.customerContext = customerCtx;
    if (customerCtx?.name) {
      this.session.callerName = customerCtx.name;
    }

    const systemPrompt = this.buildSystemPrompt(safetyRules, customerCtx);
    this.messages = [{ role: "system", content: systemPrompt }];

    const greeting = this.session.config.greeting || this.getDefaultGreeting();
    this.messages.push({ role: "assistant", content: greeting });
    this.addTranscript("assistant", greeting);
    this.ttsCharacters += greeting.length;

    return greeting;
  }

  async processUserInput(userText: string): Promise<string> {
    this.addTranscript("caller", userText);
    this.messages.push({ role: "user", content: userText });

    const startTime = Date.now();
    let response = "";

    try {
      const openaiTools = this.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

      let completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: this.messages as any,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        temperature: 0.7,
        max_tokens: 300,
      });

      let choice = completion.choices[0];
      this.trackTokenUsage(completion.usage);

      let toolCallIterations = 0;
      while (choice?.finish_reason === "tool_calls" && toolCallIterations < 5) {
        toolCallIterations++;
        const toolCalls = choice.message.tool_calls || [];
        this.messages.push({
          role: "assistant",
          content: choice.message.content || "",
          tool_calls: toolCalls,
        });

        for (const tc of toolCalls) {
          const tool = this.tools.find((t) => t.name === tc.function.name);
          let result = "Tool not found";
          if (tool) {
            try {
              const args = JSON.parse(tc.function.arguments || "{}");
              result = await tool.handler(args);
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
          this.messages.push({
            role: "tool",
            content: result,
            tool_call_id: tc.id,
          });
        }

        completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: this.messages as any,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          temperature: 0.7,
          max_tokens: 300,
        });

        choice = completion.choices[0];
        this.trackTokenUsage(completion.usage);
      }

      response = choice?.message?.content || "I'm sorry, could you repeat that?";
      this.messages.push({ role: "assistant", content: response });
      this.addTranscript("assistant", response);
      this.ttsCharacters += response.length;

      const latencyMs = Date.now() - startTime;
      logApiUsage({
        shopId: this.session.shopId,
        service: "openai",
        endpoint: "chat/completions",
        method: "POST",
        tokensInput: this.session.tokensUsed.input,
        tokensOutput: this.session.tokensUsed.output,
        totalTokens:
          this.session.tokensUsed.input + this.session.tokensUsed.output,
        latencyMs,
      }).catch(() => {});
    } catch (err) {
      console.error("[ConversationEngine] OpenAI error:", err);
      response =
        "I'm having a little trouble right now. Would you like me to transfer you to one of our team members?";
      this.messages.push({ role: "assistant", content: response });
      this.addTranscript("assistant", response);
    }

    return response;
  }

  getTtsCharacters(): number {
    return this.ttsCharacters;
  }

  getTranscript(): TranscriptEntry[] {
    return this.session.transcript;
  }

  getTokensUsed(): { input: number; output: number } {
    return this.session.tokensUsed;
  }

  private buildSystemPrompt(
    safetyRules: SafetyRule[],
    customerCtx: CustomerContext | null,
  ): string {
    const parts: string[] = [];

    parts.push(
      this.session.config.customInstructions || DEFAULT_SYSTEM_PROMPT,
    );

    parts.push(buildCustomerContextPrompt(customerCtx));
    parts.push(buildSafetyPrompt(safetyRules));

    const now = new Date();
    parts.push(`\n## CURRENT INFO\nDate/Time: ${now.toLocaleString("en-US", { timeZone: this.session.config.timezone })}`);
    parts.push(`Max call duration: ${this.session.config.maxCallDuration} seconds`);

    if (this.session.config.transferNumber) {
      parts.push(
        `Transfer number available: You can transfer the caller to a human staff member.`,
      );
    }

    return parts.join("\n");
  }

  private getDefaultGreeting(): string {
    const name = this.customerContext?.name;
    if (name) {
      return `Hello ${name.split(" ")[0]}! Thanks for calling. How can I help you today?`;
    }
    return "Hello! Thanks for calling. How can I help you today?";
  }

  private setupTools(): void {
    this.tools.push({
      name: "lookup_customer",
      description:
        "Look up the caller's customer record, vehicles, and maintenance history. Use this when the caller asks about their vehicle or service history.",
      parameters: {
        type: "object",
        properties: {
          phone: {
            type: "string",
            description: "The caller's phone number",
          },
        },
      },
      handler: async () => {
        if (this.customerContext) {
          return buildCustomerContextPrompt(this.customerContext);
        }
        const ctx = await lookupCustomerByPhone(
          this.session.callerPhone,
          this.session.shopId,
        );
        if (ctx) {
          this.customerContext = ctx;
          return buildCustomerContextPrompt(ctx);
        }
        return "No customer record found for this caller.";
      },
    });

    this.tools.push({
      name: "schedule_callback",
      description:
        "Note a callback request from the caller. Use when they want someone to call them back about scheduling, pricing, or any topic requiring human assistance.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "The reason for the callback request",
          },
          preferred_time: {
            type: "string",
            description:
              "When the caller would prefer to be called back (e.g., 'morning', 'afternoon', 'anytime')",
          },
        },
        required: ["reason"],
      },
      handler: async (args) => {
        this.session.intentDetected = "callback_requested";
        this.session.outcome = "callback_scheduled";
        return `Callback request noted: ${args.reason}. Preferred time: ${args.preferred_time || "anytime"}. A team member will follow up.`;
      },
    });

    this.tools.push({
      name: "request_transfer",
      description:
        "Transfer the caller to a human staff member. Use when the caller explicitly asks to speak to a person, or when the topic requires human assistance.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why the caller needs to be transferred",
          },
        },
        required: ["reason"],
      },
      handler: async (args) => {
        this.session.intentDetected = "transfer_requested";
        this.session.outcome = "transferred";
        this.session.transferredTo = this.session.config.transferNumber || null;
        return `Transfer initiated: ${args.reason}. Connecting to a team member now.`;
      },
    });
  }

  private addTranscript(role: "caller" | "assistant", content: string): void {
    this.session.transcript.push({
      role,
      content,
      timestamp: new Date(),
    });
  }

  private trackTokenUsage(
    usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined,
  ): void {
    if (!usage) return;
    this.session.tokensUsed.input += usage.prompt_tokens || 0;
    this.session.tokensUsed.output += usage.completion_tokens || 0;
  }
}
