import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus, getUserShopIds } from "@/lib/extension-auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { enforceAiBudget } from "@/lib/ai-budget";
import { SYMPTOM_QUESTION_GUIDE } from "@/lib/symptomQuestionGuide";
import {
  biasSymptomGuide,
  getSkipHints,
  inferSymptomCategory,
  recordRoundResults,
  renderHintsForPrompt,
  type RoundResult,
} from "@/lib/concernSkipLearning";

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

export async function GET(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const searchParams = request.nextUrl.searchParams;
    const shopId = searchParams.get("shopId");
    const limit = parseInt(searchParams.get("limit") || "20");

    const db = await getDb();
    const filter: any = { userId: auth.user._id?.toString() || auth.user.id?.toString() };
    if (shopId) filter.shopId = shopId;

    const conversations = await db.collection("concern_conversations")
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();

    return NextResponse.json({ ok: true, conversations }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Concern Assistant] GET error:", error);
    return NextResponse.json({ error: "Failed to load conversations" }, { status: 500, headers: corsHeaders });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const body = await request.json();
    const { action } = body;

    // Feature gate: concern_assistant. shopId is REQUIRED so the gate cannot
    // be bypassed by omitting it. Also enforce caller owns that shop.
    if (!body.shopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400, headers: corsHeaders }
      );
    }
    const isPlatformAdmin = auth.user.role === "platform_admin";
    const userShopIds = getUserShopIds(auth.user);
    if (!isPlatformAdmin && !userShopIds.includes(String(body.shopId))) {
      return NextResponse.json(
        { error: "Unauthorized shop access" },
        { status: 403, headers: corsHeaders }
      );
    }
    {
      const denied = await checkShopFeatureGate(Number(body.shopId), ["concern_assistant"], {
        isPlatformAdmin,
        featureLabel: "Concern Assistant",
        corsHeaders,
      });
      if (denied) return denied;
    }

    {
      const blocked = await enforceAiBudget({
        shopId: Number(body.shopId),
        route: "/api/extension/concern-assistant",
        isPlatformAdmin,
      });
      if (blocked) {
        // Re-emit with CORS headers so the extension can read it.
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
      const { concern, shopId, vin, vehicleDisplay } = body;
      if (!concern) {
        return NextResponse.json({ error: "Concern text is required" }, { status: 400, headers: corsHeaders });
      }

      const symptomCategory = inferSymptomCategory(concern);
      const hints = await getSkipHints({ db, shopId: shopId || null, symptomCategory });
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
      trackOpenAiCall(Number(body.shopId), "/api/extension/concern-assistant:followup", completion, elapsed);

      const responseText = completion.choices[0]?.message?.content || "";
      const questions = responseText
        .split('\n')
        .map(line => line.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').replace(/^Q:\s*/i, '').trim())
        .filter(line => line.length > 5 && line.endsWith('?'));

      const conversation = {
        userId,
        shopId: shopId || null,
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

      const insertResult = await db.collection("concern_conversations").insertOne(conversation);

      return NextResponse.json({
        ok: true,
        questions,
        conversationId: insertResult.insertedId.toString(),
      }, { headers: corsHeaders });
    }

    if (action === "review") {
      const { concern, answeredQuestions, conversationId, roundResults, shopId } = body;
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
            shopId: shopId || null,
            symptomCategory,
            results: cleanResults,
          });
          const { ObjectId } = await import("mongodb");
          await db.collection<{ roundResults?: unknown[] }>("concern_conversations").updateOne(
            { _id: new ObjectId(conversationId) },
            { $push: { roundResults: { results: cleanResults, recordedAt: new Date() } } },
          );
        }
      }

      const hints = await getSkipHints({ db, shopId: shopId || null, symptomCategory });
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
      trackOpenAiCall(Number(body.shopId), "/api/extension/concern-assistant:review", completion, elapsed);

      const responseText = completion.choices[0]?.message?.content || "";
      const questions = responseText
        .split('\n')
        .map(line => line.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').replace(/^Q:\s*/i, '').trim())
        .filter(line => line.length > 5 && line.endsWith('?'));

      if (conversationId) {
        const { ObjectId } = await import("mongodb");
        await db.collection("concern_conversations").updateOne(
          { _id: new ObjectId(conversationId) },
          {
            $set: { exchanges: answeredQuestions, updatedAt: new Date() }
          }
        );
      }

      return NextResponse.json({ ok: true, questions }, { headers: corsHeaders });
    }

    if (action === "cleanup") {
      const { conversationText, conversationId, concern, exchanges, roundResults, shopId } = body;
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
            shopId: shopId || null,
            symptomCategory,
            results: cleanResults,
          });
          const { ObjectId } = await import("mongodb");
          await db.collection<{ roundResults?: unknown[] }>("concern_conversations").updateOne(
            { _id: new ObjectId(conversationId) },
            { $push: { roundResults: { results: cleanResults, recordedAt: new Date() } } },
          );
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
      trackOpenAiCall(Number(body.shopId), "/api/extension/concern-assistant:cleanup", completion, elapsed);

      const cleanedText = completion.choices[0]?.message?.content?.trim() || conversationText;

      if (conversationId) {
        const { ObjectId } = await import("mongodb");
        await db.collection("concern_conversations").updateOne(
          { _id: new ObjectId(conversationId) },
          {
            $set: {
              cleanedText,
              exchanges: exchanges || [],
              status: "completed",
              updatedAt: new Date(),
            }
          }
        );
      }

      return NextResponse.json({ ok: true, cleanedText }, { headers: corsHeaders });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400, headers: corsHeaders });
  } catch (error: any) {
    console.error("[Concern Assistant] POST error:", error);
    return NextResponse.json({ error: error.message || "Failed to process request" }, { status: 500, headers: corsHeaders });
  }
}
