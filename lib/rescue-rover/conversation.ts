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
- Use brief affirmations like "Sure thing" or "Absolutely" to sound natural
- When listing items, limit to 2-3 most important ones and offer to share more

Important:
- You cannot actually book appointments — only note the request for a callback
- Always offer to transfer to a human if the caller seems frustrated or the topic is beyond your scope
- Never discuss specific pricing or provide dollar estimates — say a service advisor will discuss that
- Keep responses under 2-3 sentences when possible for natural phone conversation
- If you hear silence for a while, ask if the caller is still there
- End calls gracefully — confirm any actions taken and wish them a great day`;

interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

interface ShopContext {
  name: string;
  address: string | null;
  phone: string | null;
  businessHours: Record<string, { open: string; close: string } | null> | null;
  timezone: string;
  services: string[];
}

export class ConversationEngine {
  private messages: ConversationMessage[] = [];
  private session: CallSession;
  private tools: ConversationTool[] = [];
  private customerContext: CustomerContext | null = null;
  private shopContext: ShopContext | null = null;
  private ttsCharacters = 0;

  constructor(session: CallSession) {
    this.session = session;
    this.setupTools();
  }

  async initialize(): Promise<string> {
    const [safetyRules, customerCtx, shopCtx] = await Promise.all([
      loadSafetyRules(this.session.shopId),
      lookupCustomerByPhone(this.session.callerPhone, this.session.shopId),
      this.loadShopContext(),
    ]);

    this.customerContext = customerCtx;
    this.shopContext = shopCtx;
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
        max_tokens: 250,
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
          max_tokens: 250,
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

  async generateCallSummary(): Promise<string | null> {
    if (this.session.transcript.length <= 2) return null;

    try {
      const transcriptText = this.session.transcript
        .map(
          (t) =>
            `[${t.role === "caller" ? "Caller" : "Rescue Rover"}] ${t.content}`,
        )
        .join("\n");

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a call summarizer for an auto shop AI phone system. Write a brief, actionable summary of this phone call. Include: (1) reason for call, (2) outcome, (3) any follow-up actions needed. Keep it to 2-3 sentences. Use plain language.",
          },
          {
            role: "user",
            content: `Summarize this call transcript:\n\n${transcriptText}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 150,
      });

      this.trackTokenUsage(completion.usage);
      return completion.choices[0]?.message?.content || null;
    } catch (err) {
      console.error("[ConversationEngine] Summary generation error:", err);
      return null;
    }
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

  private async loadShopContext(): Promise<ShopContext | null> {
    try {
      const { getDb: getMongoDb } = await import("@/lib/mongo");
      const db = await getMongoDb();
      const shop = await db.collection("shops").findOne({
        shopId: { $in: [this.session.shopId, String(this.session.shopId)] },
      });

      if (!shop) return null;

      const services: string[] = [];
      if (shop.enabledFeatures?.maintenance) services.push("Maintenance planning");
      if (shop.enabledFeatures?.oil_sticker) services.push("Oil change reminders");
      if (shop.enabledFeatures?.auto_booking) services.push("Appointment scheduling");
      if (shop.enabledFeatures?.keytags) services.push("Key tags");

      const address = shop.address
        ? [shop.address.street, shop.address.city, shop.address.state, shop.address.zip]
            .filter(Boolean)
            .join(", ")
        : shop.locationAddress || null;

      return {
        name: shop.name || `Shop ${this.session.shopId}`,
        address,
        phone: shop.phone || shop.phoneNumber || null,
        businessHours: this.session.config.businessHours,
        timezone: this.session.config.timezone,
        services,
      };
    } catch (err) {
      console.error("[ConversationEngine] Failed to load shop context:", err);
      return null;
    }
  }

  private buildSystemPrompt(
    safetyRules: SafetyRule[],
    customerCtx: CustomerContext | null,
  ): string {
    const parts: string[] = [];

    parts.push(
      this.session.config.customInstructions || DEFAULT_SYSTEM_PROMPT,
    );

    if (this.shopContext) {
      parts.push(this.buildShopContextPrompt());
    }

    parts.push(buildCustomerContextPrompt(customerCtx));
    parts.push(buildSafetyPrompt(safetyRules));

    const now = new Date();
    parts.push(`\n## CURRENT INFO\nDate/Time: ${now.toLocaleString("en-US", { timeZone: this.session.config.timezone })}`);
    parts.push(`Timezone: ${this.session.config.timezone}`);
    parts.push(`Max call duration: ${this.session.config.maxCallDuration} seconds`);

    if (this.session.config.transferNumber) {
      parts.push(
        `Transfer number available: You can transfer the caller to a human staff member.`,
      );
    }

    return parts.join("\n");
  }

  private buildShopContextPrompt(): string {
    if (!this.shopContext) return "";
    const lines = ["\n## SHOP INFO"];
    lines.push(`Shop Name: ${this.shopContext.name}`);
    if (this.shopContext.address) {
      lines.push(`Address: ${this.shopContext.address}`);
    }
    if (this.shopContext.phone) {
      lines.push(`Shop Phone: ${this.shopContext.phone}`);
    }
    if (this.shopContext.services.length > 0) {
      lines.push(`Services: ${this.shopContext.services.join(", ")}`);
    }
    if (this.shopContext.businessHours) {
      lines.push("\nBusiness Hours:");
      const dayOrder = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
      for (const day of dayOrder) {
        const hours = this.shopContext.businessHours[day];
        if (hours) {
          lines.push(`  ${day.charAt(0).toUpperCase() + day.slice(1)}: ${this.formatTime(hours.open)} - ${this.formatTime(hours.close)}`);
        } else {
          lines.push(`  ${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`);
        }
      }
    }
    return lines.join("\n") + "\n";
  }

  private formatTime(time24: string): string {
    const [h, m] = time24.split(":");
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? "PM" : "AM";
    const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${hour12}:${m} ${ampm}`;
  }

  private getDefaultGreeting(): string {
    const shopName = this.shopContext?.name || "our shop";
    const name = this.customerContext?.name;
    if (name) {
      return `Hello ${name.split(" ")[0]}! Thanks for calling ${shopName}. How can I help you today?`;
    }
    return `Hello! Thanks for calling ${shopName}. How can I help you today?`;
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
      name: "check_business_hours",
      description:
        "Check the shop's business hours for a specific day or all days. Use when the caller asks about hours, when the shop is open, or operating schedule.",
      parameters: {
        type: "object",
        properties: {
          day: {
            type: "string",
            description:
              "The day to check (e.g., 'monday', 'today', 'tomorrow', 'saturday'). Use 'all' for the full weekly schedule.",
          },
        },
      },
      handler: async (args) => {
        if (!this.shopContext?.businessHours) {
          return "Business hours are not configured. Please suggest the caller contact the shop directly for hours.";
        }

        const requestedDay = (args.day as string || "all").toLowerCase();
        const hours = this.shopContext.businessHours;

        if (requestedDay === "all") {
          const dayOrder = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
          const lines = dayOrder.map((d) => {
            const h = hours[d];
            return h
              ? `${d.charAt(0).toUpperCase() + d.slice(1)}: ${this.formatTime(h.open)} - ${this.formatTime(h.close)}`
              : `${d.charAt(0).toUpperCase() + d.slice(1)}: Closed`;
          });
          return `Business hours:\n${lines.join("\n")}`;
        }

        let targetDay = requestedDay;
        if (requestedDay === "today" || requestedDay === "tomorrow") {
          const now = new Date();
          const offset = requestedDay === "tomorrow" ? 1 : 0;
          const d = new Date(now.getTime() + offset * 86400000);
          targetDay = d.toLocaleDateString("en-US", {
            weekday: "long",
            timeZone: this.shopContext.timezone,
          }).toLowerCase();
        }

        const dayHours = hours[targetDay];
        if (dayHours) {
          return `${targetDay.charAt(0).toUpperCase() + targetDay.slice(1)}: Open ${this.formatTime(dayHours.open)} to ${this.formatTime(dayHours.close)}`;
        }
        return `The shop is closed on ${targetDay.charAt(0).toUpperCase() + targetDay.slice(1)}.`;
      },
    });

    this.tools.push({
      name: "get_shop_info",
      description:
        "Get the shop's name, address, phone number, and available services. Use when the caller asks where the shop is located, the shop's phone number, or what services are offered.",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        if (!this.shopContext) {
          return "Shop information is not available.";
        }
        const info = [`Shop: ${this.shopContext.name}`];
        if (this.shopContext.address) info.push(`Address: ${this.shopContext.address}`);
        if (this.shopContext.phone) info.push(`Phone: ${this.shopContext.phone}`);
        if (this.shopContext.services.length > 0) {
          info.push(`Services: ${this.shopContext.services.join(", ")}`);
        }
        return info.join("\n");
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
          vehicle_info: {
            type: "string",
            description: "Any vehicle information mentioned (year, make, model, or VIN)",
          },
        },
        required: ["reason"],
      },
      handler: async (args) => {
        this.session.intentDetected = "callback_requested";
        this.session.outcome = "callback_scheduled";
        const parts = [`Callback request noted: ${args.reason}`];
        if (args.preferred_time) parts.push(`Preferred time: ${args.preferred_time}`);
        if (args.vehicle_info) parts.push(`Vehicle: ${args.vehicle_info}`);
        parts.push("A team member will follow up.");
        return parts.join(". ");
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
