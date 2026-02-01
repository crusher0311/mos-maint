import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { createArticle } from "@/lib/knowledge-base";
import sql from "@/lib/db/postgres";

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

  const numTicketId = Number(ticketId);
  if (isNaN(numTicketId)) {
    return NextResponse.json({ ok: false, error: "Invalid ticket ID" }, { status: 400 });
  }

  const ticketResult = await sql`
    SELECT id FROM support_tickets WHERE id = ${numTicketId} LIMIT 1
  `;
  
  if (ticketResult.length === 0) {
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

  await sql`
    UPDATE support_tickets 
    SET knowledge_article_id = ${articleId}
    WHERE id = ${numTicketId}
  `;

  return NextResponse.json({ ok: true, articleId });
}
