import { getDb } from "./mongo";
import { ObjectId } from "mongodb";
import { searchArticles, KnowledgeArticle } from "./knowledge-base";
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
        `[Article ${i + 1}]: "${article.title}"\nProblem: ${article.problem}\nSolution: ${article.solution}`
      ).join("\n\n")
    : "No relevant knowledge base articles found.";
  
  const conversationHistory = sessionHistory.slice(-6).map(msg => ({
    role: msg.role as "user" | "assistant",
    content: msg.content
  }));
  
  conversationHistory.push({ role: "user", content: userMessage });
  
  const systemPrompt = `You are a helpful support assistant for MOS Maintenance, an automotive maintenance management platform. Your job is to help users with their questions about the platform.

KNOWLEDGE BASE (use this to answer questions):
${knowledgeContext}

GUIDELINES:
1. Be friendly, helpful, and concise
2. If you find relevant information in the knowledge base, use it to answer
3. If you can't find an answer, say so and offer to create a support ticket
4. Keep responses short and actionable
5. If the user seems frustrated or the issue is complex, suggest creating a support ticket
6. Never make up information - only use what's in the knowledge base or general platform knowledge

PLATFORM OVERVIEW:
- MOS Maintenance helps auto shops manage vehicle maintenance
- Features include: maintenance recommendations, oil stickers, keytags, job history lookup, common failures advisor
- Integrates with shop management systems like Tekmetric and Protractor
- Users can manage their shop settings, view vehicles, and generate stickers

If the user wants to escalate to human support, let them know they can create a support ticket.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...conversationHistory
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    const response = completion.choices[0]?.message?.content || "I'm sorry, I couldn't generate a response. Would you like to create a support ticket?";
    
    return {
      response,
      articleIds: relevantArticles.map(a => a._id!.toString())
    };
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
