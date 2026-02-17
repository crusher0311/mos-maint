import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken } from "@/lib/extension-auth";
import { getOpenAI } from "@/lib/ai";
import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function generateFollowUpPrompt(customerConcern: string): string {
  return `You are assisting a service advisor at an auto repair shop who is speaking directly with a customer about their vehicle's issue. The customer's concern is: "${customerConcern}".

Based on this concern, generate up to 5 targeted follow-up questions the service advisor should ask the customer to gather detailed diagnostic information for the technician. Focus on:
- When the issue started and frequency
- Specific conditions (speed, temperature, load, terrain)
- Sounds, smells, vibrations, or visual symptoms
- Recent maintenance or repairs
- Any warning lights

Return ONLY the questions as a numbered list (1. 2. 3. etc), no introductory text.`;
}

function generateReviewPrompt(customerConcern: string, answeredQuestions: { question: string; response: string }[]): string {
  const qaPairs = answeredQuestions.map(r => `Q: ${r.question}\nA: ${r.response}`).join('\n\n');

  return `You are assisting a service advisor who is speaking directly with a customer to gather more details about their vehicle issue.

Customer Concern: ${customerConcern}

Previous Follow-Up Questions and Responses:
${qaPairs}

Based on the conversation so far, generate up to 3 additional follow-up questions to further clarify the issue. Avoid questions already answered. Focus on narrowing down the root cause for the technician.

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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const body = await request.json();
    const { action } = body;

    const openai = getOpenAI();
    const db = await getDb();
    const userId = auth.user._id?.toString() || auth.user.id?.toString();

    if (action === "followup") {
      const { concern, shopId, vin, vehicleDisplay } = body;
      if (!concern) {
        return NextResponse.json({ error: "Concern text is required" }, { status: 400, headers: corsHeaders });
      }

      const prompt = generateFollowUpPrompt(concern);
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
      trackApiRequest("openai", `/concern-assistant/followup`, "POST", 200, elapsed).catch(() => {});

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
        exchanges: [],
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
      const { concern, answeredQuestions, conversationId } = body;
      if (!concern || !answeredQuestions?.length) {
        return NextResponse.json({ error: "Concern and answered questions required" }, { status: 400, headers: corsHeaders });
      }

      const prompt = generateReviewPrompt(concern, answeredQuestions);
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
      trackApiRequest("openai", `/concern-assistant/review`, "POST", 200, elapsed).catch(() => {});

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
      const { conversationText, conversationId, concern, exchanges } = body;
      if (!conversationText) {
        return NextResponse.json({ error: "Conversation text required" }, { status: 400, headers: corsHeaders });
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
      trackApiRequest("openai", `/concern-assistant/cleanup`, "POST", 200, elapsed).catch(() => {});

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
