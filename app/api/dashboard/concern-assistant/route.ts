import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { enforceAiBudget } from "@/lib/ai-budget";
import { isPlatformAdmin as isPlatformAdminEmail } from "@/lib/super-admins";
import { resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor/client";
import { SYMPTOM_QUESTION_GUIDE } from "@/lib/symptomQuestionGuide";

function generateFollowUpPrompt(customerConcern: string): string {
  return `You are an experienced automotive service advisor assistant helping a service advisor gather information from a customer about their vehicle issue.

The customer's initial concern is: "${customerConcern}"

Use the following symptom-based question guide to select the most relevant follow-up questions. Match the concern to the appropriate system category and pick the best questions. Adapt the wording naturally — do not copy questions verbatim if they need context adjustments.

${SYMPTOM_QUESTION_GUIDE}

Based on the customer's concern, generate 3-5 targeted follow-up questions the service advisor should ask. Start with the most diagnostic-critical questions first. Use professional, conversational language that a service advisor would naturally use when speaking to a customer.

Return ONLY the questions as a numbered list (1. 2. 3. etc), no introductory text.`;
}

function generateReviewPrompt(customerConcern: string, answeredQuestions: { question: string; response: string }[]): string {
  const qaPairs = answeredQuestions.map(r => `Q: ${r.question}\nA: ${r.response}`).join('\n\n');

  return `You are an experienced automotive service advisor assistant helping gather more details about a vehicle issue.

Customer Concern: ${customerConcern}

Previous Follow-Up Questions and Responses:
${qaPairs}

Use this symptom-based question guide to identify any important questions not yet asked:
${SYMPTOM_QUESTION_GUIDE}

Based on the conversation so far and the question guide, generate up to 3 additional follow-up questions to further clarify the issue. Avoid repeating questions already answered. Focus on narrowing down the root cause for the technician. Use professional, conversational language.

Return ONLY the questions as a numbered list (1. 2. 3. etc), no introductory text.`;
}

function generateCleanConversationPrompt(conversationText: string): string {
  return `You are preparing a customer concern write-up for a repair order at an auto repair shop. Clean up this conversation into a clear, professional paragraph that a technician can quickly understand. Include all relevant details but remove redundancy. Write in third person (e.g., "Customer states..."). Do not use labels like "Service Advisor" or "Customer".

Conversation:
${conversationText}

Return ONLY the cleaned paragraph, no extra commentary.`;
}

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { action } = body;

    const isAdmin = await isPlatformAdminEmail(session.email);
    {
      // Gate against the SESSION shopId only — token usage is also tracked
      // against session.shopId below, so a spoofed body.shopId must never
      // shift accounting away from the actual caller's shop.
      const blocked = await enforceAiBudget({
        shopId: Number(session.shopId),
        route: "/api/dashboard/concern-assistant",
        isPlatformAdmin: isAdmin,
      });
      if (blocked) return blocked;
    }

    if (action === "followup") {
      const { concern, shopId, vin, vehicleDisplay } = body;
      if (!concern) {
        return NextResponse.json({ error: "Concern text is required" }, { status: 400 });
      }

      const openai = getOpenAI();
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
      trackOpenAiCall(Number(session.shopId), "/api/dashboard/concern-assistant:followup", completion, elapsed);

      const responseText = completion.choices[0]?.message?.content || "";
      const questions = responseText
        .split('\n')
        .map(line => line.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').replace(/^Q:\s*/i, '').trim())
        .filter(line => line.length > 5 && line.endsWith('?'));

      const db = await getDb();
      const conversation = {
        userId: session.email,
        shopId: shopId || String(session.shopId),
        vin: vin || null,
        vehicleDisplay: vehicleDisplay || null,
        concern,
        exchanges: [],
        status: "active",
        source: "dashboard",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const insertResult = await db.collection("concern_conversations").insertOne(conversation);

      return NextResponse.json({
        ok: true,
        questions,
        conversationId: insertResult.insertedId.toString(),
      });
    }

    if (action === "review") {
      const { concern, answeredQuestions, conversationId } = body;
      if (!concern || !answeredQuestions?.length) {
        return NextResponse.json({ error: "Concern and answered questions required" }, { status: 400 });
      }

      const openai = getOpenAI();
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
      trackOpenAiCall(Number(session.shopId), "/api/dashboard/concern-assistant:review", completion, elapsed);

      const responseText = completion.choices[0]?.message?.content || "";
      const questions = responseText
        .split('\n')
        .map(line => line.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').replace(/^Q:\s*/i, '').trim())
        .filter(line => line.length > 5 && line.endsWith('?'));

      if (conversationId) {
        const { ObjectId } = await import("mongodb");
        const db = await getDb();
        await db.collection("concern_conversations").updateOne(
          { _id: new ObjectId(conversationId) },
          { $set: { exchanges: answeredQuestions, updatedAt: new Date() } }
        );
      }

      return NextResponse.json({ ok: true, questions });
    }

    if (action === "cleanup") {
      const { conversationText, conversationId, concern, exchanges } = body;
      if (!conversationText) {
        return NextResponse.json({ error: "Conversation text required" }, { status: 400 });
      }

      const openai = getOpenAI();
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
      trackOpenAiCall(Number(session.shopId), "/api/dashboard/concern-assistant:cleanup", completion, elapsed);

      const cleanedText = completion.choices[0]?.message?.content?.trim() || conversationText;

      if (conversationId) {
        const { ObjectId } = await import("mongodb");
        const db = await getDb();
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

      return NextResponse.json({ ok: true, cleanedText });
    }

    if (action === "inject") {
      const { workOrderId, contactId, serviceItemId, concernText } = body;
      if (!workOrderId || !concernText) {
        return NextResponse.json({ error: "workOrderId and concernText are required" }, { status: 400 });
      }

      const config = await resolveProtractorConfig(session.shopId);
      if (!config.configured) {
        return NextResponse.json({ error: "Protractor not configured for this shop" }, { status: 400 });
      }

      let woContactId = contactId;
      let woServiceItemId = serviceItemId;

      if (!woContactId || !woServiceItemId) {
        const woResult = await protractorFetch<any>(
          `/WorkOrder/${workOrderId}`,
          config,
          {},
          0,
          session.shopId
        );
        if (woResult.ok && woResult.data) {
          if (!woContactId) woContactId = woResult.data.ContactID || woResult.data.Contact?.ID;
          if (!woServiceItemId) woServiceItemId = woResult.data.ServiceItemID || woResult.data.ServiceItem?.ID;
        }
      }

      if (!woContactId || !woServiceItemId) {
        return NextResponse.json(
          { error: "Could not resolve work order contact and vehicle. Please select a valid work order." },
          { status: 400 }
        );
      }

      const payload = {
        Type: "WorkOrder",
        ID: workOrderId,
        InvoiceNumber: 0,
        Completed: false,
        Contact: { ID: woContactId },
        ServiceItem: { ID: woServiceItemId },
        ServicePackages: {
          ItemCollection: [
            {
              ID: ZERO_GUID,
              Chapter: "Concern",
              Rank: 1,
              ServicePackageHeader: {
                Title: "Customer Concern Assistant",
                Description: concernText,
              },
              ServicePackageLines: { ItemCollection: [] },
            },
          ],
        },
      };

      const result = await protractorFetch<any>(
        `/WorkOrder/${workOrderId}`,
        config,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        0,
        session.shopId
      );

      if (!result.ok) {
        return NextResponse.json(
          { error: result.error || "Failed to add concern to work order" },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true });
    }

    if (action === "get-work-orders") {
      const config = await resolveProtractorConfig(session.shopId);
      if (!config.configured) {
        return NextResponse.json({ error: "Protractor not configured" }, { status: 400 });
      }

      const result = await protractorFetch<{ ItemCollection?: any[] }>(
        `/WorkOrder/?take=50&skip=0`,
        config,
        {},
        0,
        session.shopId
      );

      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }

      const workOrders = (result.data?.ItemCollection || [])
        .filter((wo: any) => !wo.Completed)
        .map((wo: any) => ({
          id: wo.ID,
          number: wo.WorkOrderNumber,
          status: wo.WorkflowStage || wo.Status || "Open",
          contactId: wo.ContactID || wo.Contact?.ID,
          contactName: wo.Contact?.FileAs || wo.Contact?.Name
            ? `${wo.Contact?.Name?.FirstName || ''} ${wo.Contact?.Name?.LastName || ''}`.trim()
            : null,
          serviceItemId: wo.ServiceItemID || wo.ServiceItem?.ID,
          vehicle: wo.ServiceItem
            ? `${wo.ServiceItem.Year || ''} ${wo.ServiceItem.Make || ''} ${wo.ServiceItem.Model || ''}`.trim()
            : null,
          vin: wo.ServiceItem?.VIN,
        }));

      return NextResponse.json({ ok: true, workOrders });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error: any) {
    console.error("[Dashboard Concern Assistant] Error:", error);
    return NextResponse.json({ error: error.message || "Failed to process request" }, { status: 500 });
  }
}
