import sql from "@/lib/db/postgres";
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
  id?: number;
  sessionId: string;
  userEmail: string;
  shopId: number;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
  resolved: boolean;
  escalatedToTicket?: string;
  status?: string;
  ticketId?: string;
  satisfactionRating?: number;
}

export async function getOrCreateSession(userEmail: string, shopId: number): Promise<ChatSession> {
  const sessionId = `${userEmail}-${shopId}-${Date.now()}`;
  
  const existingSessions = await sql`
    SELECT id, user_email as "userEmail", shop_id as "shopId", messages, 
           status, ticket_id as "ticketId", satisfaction_rating as "satisfactionRating",
           created_at as "createdAt", updated_at as "updatedAt"
    FROM support_chat_sessions 
    WHERE user_email = ${userEmail} 
      AND shop_id = ${String(shopId)} 
      AND status = 'active'
      AND updated_at >= NOW() - INTERVAL '24 hours'
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  
  if (existingSessions.length > 0) {
    const session = existingSessions[0];
    return {
      id: session.id as number,
      sessionId: `${session.userEmail}-${session.shopId}-${new Date(session.createdAt as Date).getTime()}`,
      userEmail: session.userEmail as string,
      shopId: Number(session.shopId),
      messages: (session.messages as ChatMessage[]) || [],
      createdAt: session.createdAt as Date,
      updatedAt: session.updatedAt as Date,
      resolved: session.status === 'resolved',
      escalatedToTicket: session.ticketId as string | undefined,
    };
  }
  
  const result = await sql`
    INSERT INTO support_chat_sessions (user_email, shop_id, status, messages)
    VALUES (${userEmail}, ${String(shopId)}, 'active', '[]'::jsonb)
    RETURNING id, created_at, updated_at
  `;
  
  return {
    id: result[0].id as number,
    sessionId,
    userEmail,
    shopId,
    messages: [],
    createdAt: result[0].created_at as Date,
    updatedAt: result[0].updated_at as Date,
    resolved: false
  };
}

export async function getSessionById(sessionId: string): Promise<ChatSession | null> {
  const parts = sessionId.split('-');
  if (parts.length < 3) return null;
  
  const userEmail = parts.slice(0, -2).join('-');
  const shopId = parts[parts.length - 2];
  const timestamp = Number(parts[parts.length - 1]);
  
  const results = await sql`
    SELECT id, user_email as "userEmail", shop_id as "shopId", messages, 
           status, ticket_id as "ticketId", satisfaction_rating as "satisfactionRating",
           created_at as "createdAt", updated_at as "updatedAt"
    FROM support_chat_sessions 
    WHERE user_email = ${userEmail} AND shop_id = ${shopId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  
  if (results.length === 0) return null;
  
  const session = results[0];
  return {
    id: session.id as number,
    sessionId,
    userEmail: session.userEmail as string,
    shopId: Number(session.shopId),
    messages: (session.messages as ChatMessage[]) || [],
    createdAt: session.createdAt as Date,
    updatedAt: session.updatedAt as Date,
    resolved: session.status === 'resolved',
    escalatedToTicket: session.ticketId as string | undefined,
  };
}

export async function addMessageToSession(sessionId: string, message: ChatMessage): Promise<void> {
  const session = await getSessionById(sessionId);
  if (!session || !session.id) return;
  
  const updatedMessages = [...session.messages, message];
  
  await sql`
    UPDATE support_chat_sessions 
    SET messages = ${JSON.stringify(updatedMessages)}::jsonb, updated_at = NOW()
    WHERE id = ${session.id}
  `;
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
      articleIds: relevantArticles.map(a => String(a.id))
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
  const session = await getSessionById(sessionId);
  if (!session || !session.id) return;
  
  await sql`
    UPDATE support_chat_sessions 
    SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
    WHERE id = ${session.id}
  `;
}

export async function linkSessionToTicket(sessionId: string, ticketId: string): Promise<void> {
  const session = await getSessionById(sessionId);
  if (!session || !session.id) return;
  
  await sql`
    UPDATE support_chat_sessions 
    SET ticket_id = ${ticketId}, escalated_at = NOW(), updated_at = NOW()
    WHERE id = ${session.id}
  `;
}

export async function getUserSessions(userEmail: string, limit: number = 10): Promise<ChatSession[]> {
  const results = await sql`
    SELECT id, user_email as "userEmail", shop_id as "shopId", messages, 
           status, ticket_id as "ticketId", satisfaction_rating as "satisfactionRating",
           created_at as "createdAt", updated_at as "updatedAt"
    FROM support_chat_sessions 
    WHERE user_email = ${userEmail}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
  
  return results.map((session: Record<string, unknown>) => ({
    id: session.id as number,
    sessionId: `${session.userEmail}-${session.shopId}-${new Date(session.createdAt as Date).getTime()}`,
    userEmail: session.userEmail as string,
    shopId: Number(session.shopId),
    messages: (session.messages as ChatMessage[]) || [],
    createdAt: session.createdAt as Date,
    updatedAt: session.updatedAt as Date,
    resolved: session.status === 'resolved',
    escalatedToTicket: session.ticketId as string | undefined,
  }));
}
