import { getDb } from "./mongo";
import { ObjectId } from "mongodb";
import { searchArticles, incrementViewCounts, KnowledgeArticle } from "./knowledge-base";
import OpenAI from "openai";

const openai = new OpenAI();

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  articleIds?: string[];
}

export interface ChatSession {
  _id?: ObjectId;
  sessionId: string;
  userEmail: string;
  shopId: number;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
  resolved: boolean;
  escalatedToTicket?: string;
}

export async function getOrCreateSession(userEmail: string, shopId: number): Promise<ChatSession> {
  const db = await getDb();
  const sessionId = `${userEmail}-${shopId}-${Date.now()}`;
  
  const existingSession = await db.collection<ChatSession>("support_chat_sessions")
    .findOne({ 
      userEmail, 
      shopId, 
      resolved: false,
      updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });
  
  if (existingSession) {
    return existingSession;
  }
  
  const newSession: ChatSession = {
    sessionId,
    userEmail,
    shopId,
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    resolved: false
  };
  
  const result = await db.collection("support_chat_sessions").insertOne(newSession);
  return { ...newSession, _id: result.insertedId };
}

export async function getSessionById(sessionId: string): Promise<ChatSession | null> {
  const db = await getDb();
  return db.collection<ChatSession>("support_chat_sessions").findOne({ sessionId });
}

export async function addMessageToSession(sessionId: string, message: ChatMessage): Promise<void> {
  const db = await getDb();
  await db.collection("support_chat_sessions").updateOne(
    { sessionId },
    { 
      $push: { messages: message as any },
      $set: { updatedAt: new Date() }
    }
  );
}

export async function generateAIResponse(
  userMessage: string, 
  sessionHistory: ChatMessage[],
  userEmail: string
): Promise<{ response: string; articleIds: string[] }> {
  const relevantArticles = await searchArticles(userMessage, 5);
  
  const knowledgeContext = relevantArticles.length > 0
    ? relevantArticles.map((article, i) => 
        `--- Article ${i + 1}: "${article.title}" [Category: ${article.category}] ---\nProblem: ${article.problem}\nSolution: ${article.solution}\nTags: ${article.tags.join(", ")}`
      ).join("\n\n")
    : "";
  
  const conversationHistory = sessionHistory.slice(-8).map(msg => ({
    role: msg.role as "user" | "assistant",
    content: msg.content
  }));
  
  conversationHistory.push({ role: "user", content: userMessage });
  
  const systemPrompt = `You are the AI support assistant for MOS Maintenance (also known as "My Oil Sticker"), an automotive maintenance management platform used by auto repair shops. You help service advisors, shop owners, and technicians get the most out of the platform.

${relevantArticles.length > 0 ? `KNOWLEDGE BASE ARTICLES (use these as your primary source of truth):
${knowledgeContext}

CITATION RULES:
- When your answer comes from a knowledge base article, naturally weave the information into your response
- If the article has specific steps, present them as a numbered list
- If multiple articles are relevant, combine their information coherently
- Prefer knowledge base information over general knowledge` : "No knowledge base articles matched this question."}

RESPONSE GUIDELINES:
1. Be friendly, professional, and concise — these are busy auto shop professionals
2. Give direct, actionable answers. Lead with the solution, then explain if needed
3. Use simple language — avoid technical jargon unless the user uses it first
4. For step-by-step instructions, use numbered lists
5. If the question is about a specific feature (stickers, keytags, maintenance plans, etc.), give practical how-to guidance
6. If you genuinely don't know the answer or it's not in the knowledge base, say so honestly and suggest creating a support ticket for human help
7. Never make up features, settings, or procedures that don't exist
8. If the user seems frustrated or has a billing/account issue, proactively suggest escalating to the support team

PLATFORM CONTEXT:
- MOS Maintenance helps auto shops manage vehicle maintenance recommendations, oil change stickers, keytags, and service history
- It integrates with shop management systems: Tekmetric and Protractor
- Features include: Vehicle Health Intelligence (maintenance plans), oil stickers with QR codes, keytag printing, job history lookup, common failures advisor, labor rate rules, customer concern assistant, canned job management
- There is a Chrome Extension that works alongside Tekmetric for quick access to these features
- Billing is VIN-based with monthly subscriptions through Stripe
- Users can manage multi-shop setups with enterprise features

Keep responses under 200 words unless detailed steps are needed. Always be helpful and solution-oriented.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...conversationHistory
      ],
      max_tokens: 600,
      temperature: 0.5
    });

    const response = completion.choices[0]?.message?.content || "I'm sorry, I couldn't generate a response. Would you like to create a support ticket?";
    
    const articleIds = relevantArticles.map(a => a._id!.toString());
    
    if (articleIds.length > 0) {
      incrementViewCounts(articleIds).catch(err => 
        console.error("[Support Chat] Failed to increment view counts:", err)
      );
    }
    
    return { response, articleIds };
  } catch (error) {
    console.error("AI chat error:", error);
    return {
      response: "I'm having trouble connecting right now. Would you like to create a support ticket instead?",
      articleIds: []
    };
  }
}

export async function markSessionResolved(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.collection("support_chat_sessions").updateOne(
    { sessionId },
    { $set: { resolved: true, updatedAt: new Date() } }
  );
}

export async function linkSessionToTicket(sessionId: string, ticketId: string): Promise<void> {
  const db = await getDb();
  await db.collection("support_chat_sessions").updateOne(
    { sessionId },
    { $set: { escalatedToTicket: ticketId, updatedAt: new Date() } }
  );
}

export async function getUserSessions(userEmail: string, limit: number = 10): Promise<ChatSession[]> {
  const db = await getDb();
  return db.collection<ChatSession>("support_chat_sessions")
    .find({ userEmail })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
}
