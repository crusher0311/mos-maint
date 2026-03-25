import OpenAI from "openai";
import type {
  CallSession,
  RescueRoverConfig,
  ClientContext,
  SafetyRule,
  ConversationTool,
  TranscriptEntry,
} from "./types";
import { loadSafetyRules, buildSafetyPrompt } from "./safety-rules";
import {
  lookupClientByPhone,
  buildClientContextPrompt,
} from "./client-context";
import { logApiUsage } from "./cost-tracking";

const openai = new OpenAI();

const DEFAULT_SYSTEM_PROMPT = `You are Rescue Rover, a friendly and knowledgeable AI phone support assistant for MOS Tools — a SaaS platform that helps auto repair shops manage vehicle maintenance recommendations, customer data, and shop operations.

Your callers are shop owners, service advisors, and managers who use the MOS Tools platform. You are NOT speaking to vehicle owners or end customers.

Your role is to:
1. Greet callers warmly and professionally
2. Help them with questions about the MOS Tools platform — features, settings, integrations
3. Troubleshoot common issues with their account, integrations, or features
4. Check their account status, billing, and integration health
5. Create support tickets for issues that need follow-up from the team
6. Transfer calls to the MOS support team when you cannot resolve an issue

Communication style:
- Be concise — phone conversations should be brief and clear
- Speak naturally, as if talking to a helpful colleague
- Use simple language, avoid overly technical jargon unless the caller uses it first
- Confirm understanding before taking action
- Never make up information you don't have
- Use brief affirmations like "Sure thing" or "Absolutely" to sound natural
- When listing items, limit to 2-3 most important ones and offer to share more

Important:
- Always offer to transfer to a human support team member if the caller seems frustrated or needs help beyond your capabilities
- You cannot make changes to their account, billing, or integrations — only check status and log tickets
- If asked about pricing or billing changes, offer to connect them with the billing team or log a ticket
- Keep responses under 2-3 sentences when possible for natural phone conversation
- If you hear silence for a while, ask if the caller is still there
- End calls gracefully — confirm any actions taken and wish them a great day

Platform features you should know about:
- Vehicle Health Intelligence (VHI): Analyzes maintenance needs based on OEM schedules and service history
- Oil Sticker / Key Tag printing: Custom sticker and keytag generation with QR codes
- Chrome Extension "Detect Dog": Adds maintenance recommendations to shop management systems
- Shop management integrations: Protractor, Tekmetric, Shop-Ware, AutoFlow
- CARFAX integration: Vehicle history data
- Auto Booking: Automated appointment scheduling
- AI features: Smart job autocomplete, common failures advisor, customer concern assistant
- CRM: Account management, contacts, sales pipeline
- Communications: SMS, voice calling, email via platform`;

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
  private clientContext: ClientContext | null = null;
  private ttsCharacters = 0;

  constructor(session: CallSession) {
    this.session = session;
    this.setupTools();
  }

  async initialize(): Promise<string> {
    const [safetyRules, clientCtx] = await Promise.all([
      loadSafetyRules(this.session.shopId),
      lookupClientByPhone(this.session.callerPhone, this.session.shopId),
    ]);

    this.clientContext = clientCtx;
    if (clientCtx?.contactName) {
      this.session.callerName = clientCtx.contactName;
    }

    const systemPrompt = this.buildSystemPrompt(safetyRules, clientCtx);
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
        "I'm having a little trouble right now. Would you like me to transfer you to the support team?";
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
            `[${t.role === "caller" ? "Client" : "Rescue Rover"}] ${t.content}`,
        )
        .join("\n");

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a call summarizer for MOS Tools, an automotive SaaS platform support line. The callers are shop owners and managers who use the platform. Write a brief, actionable summary of this support call. Include: (1) reason for call, (2) outcome, (3) any follow-up actions needed. Keep it to 2-3 sentences. Use plain language.",
          },
          {
            role: "user",
            content: `Summarize this support call transcript:\n\n${transcriptText}`,
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

  private buildSystemPrompt(
    safetyRules: SafetyRule[],
    clientCtx: ClientContext | null,
  ): string {
    const parts: string[] = [];

    parts.push(
      this.session.config.customInstructions || DEFAULT_SYSTEM_PROMPT,
    );

    parts.push(buildClientContextPrompt(clientCtx));
    parts.push(buildSafetyPrompt(safetyRules));

    const now = new Date();
    parts.push(
      `\n## CURRENT INFO\nDate/Time: ${now.toLocaleString("en-US", { timeZone: this.session.config.timezone })}`,
    );
    parts.push(`Timezone: ${this.session.config.timezone}`);
    parts.push(
      `Max call duration: ${this.session.config.maxCallDuration} seconds`,
    );

    if (this.session.config.transferNumber) {
      parts.push(
        `Transfer number available: You can transfer the caller to the MOS support team.`,
      );
    }

    return parts.join("\n");
  }

  private getDefaultGreeting(): string {
    const name = this.clientContext?.contactName;
    if (name) {
      return `Hey ${name.split(" ")[0]}! Thanks for calling MOS Tools support. How can I help you today?`;
    }
    return `Hello! Thanks for calling MOS Tools support. How can I help you today?`;
  }

  private setupTools(): void {
    this.tools.push({
      name: "lookup_account",
      description:
        "Look up the caller's shop account details including billing status, plan, connected integrations, enabled features, and vehicle count. Use this when the caller asks about their account, subscription, or wants to verify what's set up.",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        if (this.clientContext) {
          return buildClientContextPrompt(this.clientContext);
        }
        const ctx = await lookupClientByPhone(
          this.session.callerPhone,
          this.session.shopId,
        );
        if (ctx) {
          this.clientContext = ctx;
          return buildClientContextPrompt(ctx);
        }
        return "No account record found for this caller's phone number.";
      },
    });

    this.tools.push({
      name: "check_integration_status",
      description:
        "Check the status of the caller's shop management system integrations (Protractor, Tekmetric, Shop-Ware, AutoFlow, CARFAX). Use when they ask about sync issues, data not showing up, or integration problems.",
      parameters: {
        type: "object",
        properties: {
          integration: {
            type: "string",
            description:
              "Specific integration to check (protractor, tekmetric, shopware, autoflow, carfax), or 'all' for everything",
          },
        },
      },
      handler: async (args) => {
        if (!this.clientContext) {
          return "Unable to look up integration status — no account found for this caller.";
        }
        const integration = (
          (args.integration as string) || "all"
        ).toLowerCase();
        const integrations = this.clientContext.integrations;

        if (integration === "all") {
          const lines = ["Integration Status:"];
          lines.push(
            `  Protractor: ${integrations.protractor ? "Connected" : "Not connected"}`,
          );
          lines.push(
            `  Tekmetric: ${integrations.tekmetric ? "Connected" : "Not connected"}`,
          );
          lines.push(
            `  Shop-Ware: ${integrations.shopware ? "Connected" : "Not connected"}`,
          );
          lines.push(
            `  AutoFlow: ${integrations.autoflow ? "Connected" : "Not connected"}`,
          );
          lines.push(
            `  CARFAX: ${integrations.carfax ? "Connected" : "Not connected"}`,
          );
          if (integrations.smsProvider) {
            lines.push(`  SMS Provider: ${integrations.smsProvider}`);
          }
          return lines.join("\n");
        }

        const statusMap: Record<string, boolean> = {
          protractor: integrations.protractor,
          tekmetric: integrations.tekmetric,
          shopware: integrations.shopware,
          autoflow: integrations.autoflow,
          carfax: integrations.carfax,
        };

        const isConnected = statusMap[integration];
        if (isConnected === undefined) {
          return `Unknown integration: ${integration}. Available: Protractor, Tekmetric, Shop-Ware, AutoFlow, CARFAX.`;
        }

        return `${integration.charAt(0).toUpperCase() + integration.slice(1)}: ${isConnected ? "Connected and configured" : "Not connected. The team can help set this up."}`;
      },
    });

    this.tools.push({
      name: "check_feature_status",
      description:
        "Check which platform features are enabled for the caller's shop. Use when they ask about specific features, why something isn't available, or what their plan includes.",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        if (!this.clientContext) {
          return "Unable to check features — no account found for this caller.";
        }

        const features = this.clientContext.enabledFeatures;
        if (features.length === 0) {
          return "No features are currently enabled for this shop. The support team can help configure features based on the shop's plan.";
        }

        return `Enabled features for ${this.clientContext.shopName || "this shop"}:\n${features.join(", ")}\n\nPlan: ${this.clientContext.billing.plan || "Unknown"}`;
      },
    });

    this.tools.push({
      name: "create_support_ticket",
      description:
        "Create a support ticket for an issue that needs follow-up from the MOS team. Use when the caller reports a bug, needs a configuration change, or has an issue you can't resolve on the call.",
      parameters: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description: "Brief summary of the issue",
          },
          description: {
            type: "string",
            description:
              "Detailed description of the problem or request, including any troubleshooting already attempted",
          },
          category: {
            type: "string",
            enum: [
              "technical",
              "billing",
              "integration",
              "feature_request",
              "general",
            ],
            description: "The category of the support ticket",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
            description: "Priority level based on impact to the shop",
          },
        },
        required: ["subject", "description", "category", "priority"],
      },
      handler: async (args) => {
        try {
          const { getDb: getMongoDb } = await import("@/lib/mongo");
          const db = await getMongoDb();

          const ticketNumber = `RR-${Date.now().toString(36).toUpperCase()}`;

          await db.collection("support_tickets").insertOne({
            ticketNumber,
            subject: args.subject,
            description: args.description,
            category: args.category,
            priority: args.priority,
            status: "open",
            source: "rescue_rover_call",
            shopId: this.clientContext?.shopId || this.session.shopId,
            shopName: this.clientContext?.shopName || null,
            userEmail: this.clientContext?.email || null,
            userName: this.clientContext?.contactName || null,
            callerPhone: this.session.callerPhone,
            callSid: this.session.callSid,
            messages: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          this.session.intentDetected = "support_ticket_created";
          this.session.outcome = "ticket_created";

          return `Support ticket ${ticketNumber} has been created. Subject: ${args.subject}. Priority: ${args.priority}. The support team will follow up.`;
        } catch (err) {
          console.error("[RescueRover] Failed to create ticket:", err);
          return "I wasn't able to create the ticket in the system. Let me transfer you to the support team instead.";
        }
      },
    });

    this.tools.push({
      name: "check_open_tickets",
      description:
        "Check the caller's existing open support tickets. Use when they ask about the status of a previous issue or want to know if there are outstanding tickets.",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        try {
          const { getDb: getMongoDb } = await import("@/lib/mongo");
          const db = await getMongoDb();
          const shopId = this.clientContext?.shopId || this.session.shopId;

          const tickets = await db
            .collection("support_tickets")
            .find({
              shopId: { $in: [shopId, String(shopId)] },
              status: { $in: ["open", "in_progress", "pending"] },
            })
            .sort({ createdAt: -1 })
            .limit(5)
            .toArray();

          if (tickets.length === 0) {
            return "No open support tickets found for this shop.";
          }

          const lines = [`Open tickets (${tickets.length}):`];
          for (const t of tickets) {
            const created = new Date(t.createdAt).toLocaleDateString("en-US");
            lines.push(
              `  - ${t.ticketNumber || "No #"}: ${t.subject} (${t.priority || "normal"} priority, opened ${created})`,
            );
          }
          return lines.join("\n");
        } catch (err) {
          console.error("[RescueRover] Failed to fetch tickets:", err);
          return "Unable to retrieve ticket information right now.";
        }
      },
    });

    this.tools.push({
      name: "request_transfer",
      description:
        "Transfer the caller to the MOS support team. Use when the caller explicitly asks to speak to a person, when you cannot resolve their issue, or when they need account changes you can't make.",
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
        this.session.transferredTo =
          this.session.config.transferNumber || null;
        return `Transfer initiated: ${args.reason}. Connecting to the support team now.`;
      },
    });

    this.tools.push({
      name: "schedule_callback",
      description:
        "Schedule a callback from the MOS support team. Use when the caller needs help at a different time, or when the support team is unavailable for a transfer.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "What the caller needs help with",
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
        const parts = [`Callback request noted: ${args.reason}`];
        if (args.preferred_time)
          parts.push(`Preferred time: ${args.preferred_time}`);
        parts.push("A team member will reach out.");
        return parts.join(". ");
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
    usage:
      | { prompt_tokens?: number; completion_tokens?: number }
      | null
      | undefined,
  ): void {
    if (!usage) return;
    this.session.tokensUsed.input += usage.prompt_tokens || 0;
    this.session.tokensUsed.output += usage.completion_tokens || 0;
  }
}
