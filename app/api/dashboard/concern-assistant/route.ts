import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { enforceAiBudget } from "@/lib/ai-budget";
import { isPlatformAdmin as isPlatformAdminEmail } from "@/lib/super-admins";
import { resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor/client";

const SYMPTOM_QUESTION_GUIDE = `
GENERAL QUESTIONS (use when applicable):
- What symptoms are you experiencing?
- How long have you been experiencing these symptoms?
- Do these symptoms occur at a specific time or under specific conditions?
- Are any warning lights on? If yes, describe which ones.
- Tell me the story about your [issue/symptom]. What happened?

SYSTEM-SPECIFIC QUESTIONS:

CHECK ENGINE LIGHT:
- How long has the warning light been on?
- Is the light flashing or steady?
- Are there additional warning lights on?

BATTERY/ALTERNATOR (WILL NOT START):
- Have you had to jump-start the vehicle?
- Is the vehicle starting?
- Does it make any noise when you try to start it?
- Are the dashboard lights on when the key is turned to the "on" position?

BRAKES:
- Are any warning lights on?
- Are you hearing any noises? When does the noise occur? Where does it come from? How long? Has it changed?
- Is the steering wheel shaking? While braking or all the time?
- Does the brake pedal feel different (soft, hard, or pulsating)?
- When was your last brake inspection or replacement?

COOLING SYSTEM:
- What is the temperature gauge reading?
- Are you seeing fluid on the ground under the engine?
- Do you see steam coming from the engine?

TRANSMISSION:
- Is it automatic or manual?
- Can the vehicle be driven or does it need a tow?
- Does the vehicle work in reverse?

STEERING AND SUSPENSION:
- Under what conditions do symptoms occur (moving, turning, etc.)?
- Is the vehicle pulling to one side?
- Are you hearing any noises?

TIRES:
- What is the condition? Worn out, too old, or damaged?
- What are you looking for in a tire (performance, longevity)?
- Do you have a preferred tire brand?
- What size and brand are currently on the vehicle?

ALIGNMENT:
- Have you recently had suspension, steering, or tire work done?
- Have you noticed vibrations, pulling, or anything unusual?
- Have you hit a pothole or curb?
- When was your last alignment?

AIR CONDITIONING:
- How long has it not been working?
- Is it blowing warm air?
- Does the air blow at all? At high or low speeds?
- When was it last charged or repaired?

TIMING BELT:
- Is the vehicle running normally?
- Are you replacing due to age or mileage?
- Do you have service records?

EMISSIONS:
- Are any warning lights on?
- Are you noticing any symptoms?
- How long have you owned the vehicle?
- When is your vehicle registration due?

TUNE-UP:
- Are you seeking a tune-up to fix a specific problem or as routine maintenance?
- Is there anything specific you want to replace (spark plugs, filters)?
- When was the last time your vehicle was serviced?

CUSTOMER-REPORTED SMELL:
- How long have you been experiencing the smell?
- Can you describe it? Sweet, burning, musty, plastic-like?
- Where does it seem to come from?
- What steps replicate the smell?

ENGINE OR TRANSMISSION REPLACEMENT:
- Is the vehicle drivable or does it need a tow?
- What symptoms are you having?
- Do you have a budget you are aiming for?
- Is this your everyday driver?
- Are you looking for a cheaper price or a second opinion?
- What are your long-term plans with the vehicle?
- Do you have a preference between used, new, or rebuilt?

COMMUNICATION STYLE:
- Never say "What makes you think you need a...?" Instead say "Tell me about the [issue/component]. What symptoms are you experiencing?"
- Never say "Have you had it inspected?" Instead say "Have you had a trusted shop perform the necessary testing?"
`;

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
