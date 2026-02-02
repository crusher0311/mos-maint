import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { createArticle } from "@/lib/knowledge-base";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export async function POST(req: NextRequest) {
  const admin = await requirePlatformAdmin();

  const body = await req.json();
  const { ticketId, title, problem, solution, category, tags } = body;

  if (!ticketId || !title || !problem || !solution) {
    return NextResponse.json({ 
      ok: false, 
      error: "Ticket ID, title, problem, and solution are required" 
    }, { status: 400 });
  }

  if (!ObjectId.isValid(ticketId)) {
    return NextResponse.json({ ok: false, error: "Invalid ticket ID" }, { status: 400 });
  }

  const db = await getDb();
  const ticket = await db.collection("support_tickets").findOne({ _id: new ObjectId(ticketId) });
  
  if (!ticket) {
    return NextResponse.json({ ok: false, error: "Ticket not found" }, { status: 404 });
  }

  const articleId = await createArticle({
    title,
    problem,
    solution,
    category: category || "general",
    tags: tags || [],
    sourceTicketId: ticketId,
    createdBy: admin.email
  });

  await db.collection("support_tickets").updateOne(
    { _id: new ObjectId(ticketId) },
    { $set: { knowledgeArticleId: articleId } }
  );

  return NextResponse.json({ ok: true, articleId });
}
