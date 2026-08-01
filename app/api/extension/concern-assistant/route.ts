import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { getDb } from "@/lib/mongo";
import {
  findConversationRoundResults,
  findConversationsForUser,
  insertConversation,
  pushRoundResults,
  updateConversationSet,
} from "@/lib/data/repositories/concern-conversations";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { enforceAiBudget } from "@/lib/ai-budget";
import { SYMPTOM_QUESTION_GUIDE } from "@/lib/symptomQuestionGuide";
import {
  biasSymptomGuide,
  dedupeFollowUpQuestions,
  getSkipHints,
  inferSymptomCategory,
  recordRoundResults,
  renderHintsForPrompt,
  type RoundResult,
} from "@/lib/concernSkipLearning";
import { validateExtensionToken, getAuthErrorStatus , buildAuthErrorBody } from "@/lib/extension-auth";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function generateFollowUpPrompt(customerConcern: string, guide: string, hintsBlock: string): string {
  return `You are an experienced automotive service advisor assistant helping a service advisor gather information from a customer about their vehicle issue.

The customer's initial concern is: "${customerConcern}"

Use the following symptom-based question guide to select the most relevant follow-up questions. Match the concern to the appropriate system category and pick the best questions. Adapt the wording naturally — do not copy questions verbatim if they need context adjustments.

${guide}

${hintsBlock}Based on the customer's concern, generate 3-5 targeted follow-up questions the service advisor should ask. Start with the most diagnostic-critical questions first. Use professional, conversational language that a service advisor would naturally use when speaking to a customer.

Return ONLY the questions as a numbered list (1. 2. 3. etc), no introductory text.`;
}

function generateReviewPrompt(customerConcern: string, answeredQuestions: { question: string; response: string }[], guide: string, hintsBlock: string): string {
  const qaPairs = answeredQuestions.map(r => `Q: ${r.question}\nA: ${r.response}`).join('\n\n');

  return `You are an experienced automotive service advisor assistant helping gather more details about a vehicle issue.

Customer Concern: ${customerConcern}

Previous Follow-Up Questions and Responses:
${qaPairs}

Use this symptom-based question guide to identify any important questions not yet asked:
${guide}

${hintsBlock}Based on the conversation so far and the question guide, generate up to 3 additional follow-up questions to further clarify the issue. Avoid repeating questions already answered. Focus on narrowing down the root cause for the technician. Use professional, conversational language.

Return ONLY the questions as a numbered list (1. 2. 3. etc), no introductory text.`;
}

function generateCleanConversationPrompt(conversationText: string): string {
  return `You are preparing a customer concern write-up for a repair order at an auto repair shop. Clean up this conversation into a clear, professional paragraph that a technician can quickly understand. Include all relevant details but remove redundancy. Write in third person (e.g., "Customer states..."). Do not use labels like "Service Advisor" or "Customer".

Conversation:
${conversationText}

Return ONLY the cleaned paragraph, no extra commentary.`;
}

/**
 * Gather every question ever shown in this conversation so a fresh "More
 * Questions" round can be hard-deduped against it (Task #682). Mirrors the
 * dashboard route: accumulated answered exchanges + current round results +
 * the conversation's stored round history (which already includes the
 * just-pushed current round).
 */
async function collectAskedQuestions(opts: {
  db: any;
  conversationId?: string;
  answeredQuestions?: { question?: string }[];
  roundResults?: { question?: string }[];
}): Promise<string[]> {
  const { db, conversationId, answeredQuestions, roundResults } = opts;
  const asked: string[] = [];

  if (Array.isArray(answeredQuestions)) {
    for (const a of answeredQuestions) {
      if (a?.question) asked.push(String(a.question));
    }
  }
  if (Array.isArray(roundResults)) {
    for (const r of roundResults) {
      if (r?.question) asked.push(String(r.question));
    }
  }

  if (conversationId) {
    try {
      const conv = await findConversationRoundResults(conversationId);
      const rounds = (conv as any)?.roundResults;
      if (Array.isArray(rounds)) {
        for (const round of rounds) {
          for (const item of round?.results || []) {
            if (item?.question) asked.push(String(item.question));
          }
        }
      }
    } catch {
      // Best-effort: a bad/aged conversationId just means we dedup against
      // the request-provided history only.
    }
  }

  return asked;
}

async function _GET(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(buildAuthErrorBody(auth), { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const searchParams = request.nextUrl.searchParams;
    const rawShopId = searchParams.get("shopId");
    const provider = searchParams.get("provider");
    const limit = parseInt(searchParams.get("limit") || "20");

    const userId = auth.user._id?.toString() || auth.user.id?.toString();
    let mosShopId: number | undefined;

    if (rawShopId) {
      // Resolve raw provider shopId to canonical mosShopId at the boundary
      // (Task #300). Reads prefer mosShopId, fall back to legacy shopId for
      // docs written before the dual-write/backfill rolled out.
      const guard = await guardExtensionShopRequest(request, {
        smsShopId: rawShopId,
        provider,
        requiredFeatures: ["concern_assistant"],
        featureLabel: "Concern Assistant",
        corsHeaders,
      });
      if (!guard.ok) return guard.response;
      mosShopId = guard.mosShopId;
    }

    const conversations = await findConversationsForUser({
      userId: userId as string,
      mosShopId,
      rawShopId: rawShopId ?? null,
      limit,
    });

    return NextResponse.json({ ok: true, conversations }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Concern Assistant] GET error:", error);
    return NextResponse.json({ error: "Failed to load conversations" }, { status: 500, headers: corsHeaders });
  }
}

async function _POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (!body.shopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Single shop-resolution boundary (Task #300): the extension keeps
    // sending the raw provider shopId, but the server resolves it to the
    // canonical mosShopId exactly once at the edge. Auth, ownership, and
    // feature-gate checks all live inside the guard.
    const guard = await guardExtensionShopRequest(request, {
      smsShopId: body.shopId,
      provider: body.provider,
      requiredFeatures: ["concern_assistant"],
      featureLabel: "Concern Assistant",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;
    const mosShopId = guard.mosShopId;
    const auth = { user: guard.user };

    {
      const blocked = await enforceAiBudget({
        shopId: mosShopId,
        route: "/api/extension/concern-assistant",
        isPlatformAdmin: guard.isPlatformAdmin,
      });
      if (blocked) {
        const data = await blocked.json();
        return NextResponse.json(data, {
          status: blocked.status,
          headers: { ...corsHeaders, ...(blocked.headers.get("Retry-After") ? { "Retry-After": blocked.headers.get("Retry-After")! } : {}) },
        });
      }
    }

    const openai = getOpenAI();
    const db = await getDb();
    const userId = auth.user._id?.toString() || auth.user.id?.toString();

    if (action === "followup") {
      const { concern, vin, vehicleDisplay } = body;
      if (!concern) {
        return NextResponse.json({ error: "Concern text is required" }, { status: 400, headers: corsHeaders });
      }

      const symptomCategory = inferSymptomCategory(concern);
      const hints = await getSkipHints({ db, mosShopId, symptomCategory });
      const biasedGuide = biasSymptomGuide(SYMPTOM_QUESTION_GUIDE, hints.avoid);
      const hintsBlock = renderHintsForPrompt(hints);

      const prompt = generateFollowUpPrompt(concern, biasedGuide, hintsBlock);
      const startTime = Date.now();

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are an experienced automotive service advisor assistant." },
          { role: "user", content: prompt }
        ],
        max_tokens: 1000,
        temperature: 0.7,
      });

      const elapsed = Date.now() - startTime;
      trackOpenAiCall(mosShopId, "/api/extension/concern-assistant:followup", completion, elapsed);

      const responseText = completion.choices[0]?.message?.content || "";
      const questions = responseText
        .split('\n')
        .map(line => line.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').replace(/^Q:\s*/i, '').trim())
        .filter(line => line.length > 5 && line.endsWith('?'));

      const conversation = {
        userId,
        // Task #300: mosShopId is the canonical shop key; shopId (raw) is
        // kept on the document so the backfill / read-fallback can still
        // identify pre-migration history.
        mosShopId,
        shopId: body.shopId || null,
        vin: vin || null,
        vehicleDisplay: vehicleDisplay || null,
        concern,
        symptomCategory,
        exchanges: [],
        roundResults: [] as { results: RoundResult[]; recordedAt: Date }[],
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const insertedId = await insertConversation(conversation);

      return NextResponse.json({
        ok: true,
        questions,
        conversationId: insertedId,
      }, { headers: corsHeaders });
    }

    if (action === "review") {
      const { concern, answeredQuestions, conversationId, roundResults } = body;
      if (!concern || !answeredQuestions?.length) {
        return NextResponse.json({ error: "Concern and answered questions required" }, { status: 400, headers: corsHeaders });
      }

      const symptomCategory = inferSymptomCategory(concern);

      if (Array.isArray(roundResults) && roundResults.length > 0 && conversationId) {
        const cleanResults: RoundResult[] = roundResults
          .filter((r: any) => typeof r?.question === "string" && r.question.trim())
          .map((r: any) => ({ question: String(r.question), answered: !!r.answered }));
        if (cleanResults.length) {
          await recordRoundResults({
            db,
            mosShopId,
            symptomCategory,
            results: cleanResults,
          });
          await pushRoundResults(conversationId, {
            results: cleanResults,
            recordedAt: new Date(),
          });
        }
      }

      const hints = await getSkipHints({ db, mosShopId, symptomCategory });
      const biasedGuide = biasSymptomGuide(SYMPTOM_QUESTION_GUIDE, hints.avoid);
      const hintsBlock = renderHintsForPrompt(hints);

      const prompt = generateReviewPrompt(concern, answeredQuestions, biasedGuide, hintsBlock);
      const startTime = Date.now();

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are an experienced automotive service advisor assistant." },
          { role: "user", content: prompt }
        ],
        max_tokens: 800,
        temperature: 0.7,
      });

      const elapsed = Date.now() - startTime;
      trackOpenAiCall(mosShopId, "/api/extension/concern-assistant:review", completion, elapsed);

      const responseText = completion.choices[0]?.message?.content || "";
      const rawQuestions = responseText
        .split('\n')
        .map(line => line.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').replace(/^Q:\s*/i, '').trim())
        .filter(line => line.length > 5 && line.endsWith('?'));

      // Hard-enforce no-repeats (Task #682) — same logic as the dashboard
      // route so both surfaces behave identically.
      const alreadyAsked = await collectAskedQuestions({
        db,
        conversationId,
        answeredQuestions,
        roundResults,
      });
      const questions = dedupeFollowUpQuestions(rawQuestions, alreadyAsked);
      const noMoreQuestions = questions.length === 0;

      if (conversationId) {
        await updateConversationSet(conversationId, {
          exchanges: answeredQuestions,
          updatedAt: new Date(),
        });
      }

      return NextResponse.json({ ok: true, questions, noMoreQuestions }, { headers: corsHeaders });
    }

    if (action === "cleanup") {
      const { conversationText, conversationId, concern, exchanges, roundResults } = body;
      if (!conversationText) {
        return NextResponse.json({ error: "Conversation text required" }, { status: 400, headers: corsHeaders });
      }

      if (Array.isArray(roundResults) && roundResults.length > 0 && conversationId && concern) {
        const symptomCategory = inferSymptomCategory(concern);
        const cleanResults: RoundResult[] = roundResults
          .filter((r: any) => typeof r?.question === "string" && r.question.trim())
          .map((r: any) => ({ question: String(r.question), answered: !!r.answered }));
        if (cleanResults.length) {
          await recordRoundResults({
            db,
            mosShopId,
            symptomCategory,
            results: cleanResults,
          });
          await pushRoundResults(conversationId, {
            results: cleanResults,
            recordedAt: new Date(),
          });
        }
      }

      const prompt = generateCleanConversationPrompt(conversationText);
      const startTime = Date.now();

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a professional automotive service writer." },
          { role: "user", content: prompt }
        ],
        max_tokens: 1000,
        temperature: 0.3,
      });

      const elapsed = Date.now() - startTime;
      trackOpenAiCall(mosShopId, "/api/extension/concern-assistant:cleanup", completion, elapsed);

      const cleanedText = completion.choices[0]?.message?.content?.trim() || conversationText;

      if (conversationId) {
        await updateConversationSet(conversationId, {
          cleanedText,
          exchanges: exchanges || [],
          status: "completed",
          updatedAt: new Date(),
        });
      }

      return NextResponse.json({ ok: true, cleanedText }, { headers: corsHeaders });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400, headers: corsHeaders });
  } catch (error: any) {
    console.error("[Concern Assistant] POST error:", error);
    return NextResponse.json({ error: error.message || "Failed to process request" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
export const POST = withExtensionErrorMarker(_POST as any);
