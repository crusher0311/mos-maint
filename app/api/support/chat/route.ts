import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  getOrCreateSession, 
  addMessageToSession, 
  generateAIResponse,
  ChatMessage 
} from "@/lib/support-chat";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const chatSession = await getOrCreateSession(session.email, session.shopId);

  return NextResponse.json({
    ok: true,
    session: {
      sessionId: chatSession.sessionId,
      messages: chatSession.messages,
      resolved: chatSession.resolved
    }
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { message } = body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json({ ok: false, error: "Message is required" }, { status: 400 });
  }

  const chatSession = await getOrCreateSession(session.email, session.shopId);

  const userMessage: ChatMessage = {
    role: "user",
    content: message.trim(),
    timestamp: new Date()
  };

  await addMessageToSession(chatSession.sessionId, userMessage);

  const { response, articleIds } = await generateAIResponse(
    message.trim(),
    chatSession.messages,
    session.email
  );

  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: response,
    timestamp: new Date(),
    articleIds
  };

  await addMessageToSession(chatSession.sessionId, assistantMessage);

  return NextResponse.json({
    ok: true,
    response,
    sessionId: chatSession.sessionId
  });
}
